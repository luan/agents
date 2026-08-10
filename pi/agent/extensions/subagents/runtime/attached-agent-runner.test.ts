import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectAttachedAgent, runAttachedAgent } from "./attached-agent-runner";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function connect(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 3000;
		const attempt = () => {
			if (!existsSync(path)) {
				if (Date.now() >= deadline) {
					reject(new Error(`Socket did not appear: ${path}`));
					return;
				}
				setTimeout(attempt, 25);
				return;
			}
			const socket = createConnection(path);
			socket.once("connect", () => resolve(socket));
			socket.once("error", (error) => {
				socket.destroy();
				if (Date.now() >= deadline) reject(error);
				else setTimeout(attempt, 25);
			});
		};
		attempt();
	});
}

function messages(socket: Socket) {
	let buffer = "";
	const queue: any[] = [];
	const waiters: Array<(message: any) => void> = [];
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const waiter = waiters.shift();
			if (waiter) waiter(message);
			else queue.push(message);
		}
	});
	return async (type: string): Promise<any> => {
		for (;;) {
			const index = queue.findIndex((message) => message.type === type);
			if (index >= 0) return queue.splice(index, 1)[0];
			const message = await new Promise<any>((resolve) => waiters.push(resolve));
			if (message.type === type) return message;
			queue.push(message);
		}
	};
}

test("attached agent startup honors cancellation before launching its terminal", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runAttachedAgent({} as never, "task", "work", "root", "agent", {
			signal: controller.signal,
		} as never),
	).rejects.toThrow();
});

test("attached agent launcher keeps long Pi arguments out of the RMUX command", async () => {
	const root = mkdtempSync(join(tmpdir(), "attached-agent-launcher-"));
	roots.push(root);
	const logPath = join(root, "args.json");
	const cliPath = join(root, "fake-cli.mjs");
	const configPath = join(root, "config.json");
	writeFileSync(
		cliPath,
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2).map((value) => value.length), agentName: process.env.PI_SUBAGENT_NAME }));`,
	);
	writeFileSync(
		configPath,
		JSON.stringify({
			cliPath,
			cwd: root,
			args: ["--system-prompt", "x".repeat(100_000)],
			prompt: "y".repeat(100_000),
			agentName: "worker",
		}),
	);
	const launcher = join(import.meta.dir, "attached-agent-launcher.mjs");
	const child = spawn(process.execPath, [launcher, configPath], { stdio: "ignore" });
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));

	expect(code).toBe(0);
	expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual({
		args: [15, 100_000, 100_000],
		agentName: "worker",
	});
});

test("attached agent control reports events and accepts commands", async () => {
	const root = mkdtempSync(join(tmpdir(), "attached-agent-"));
	roots.push(root);
	const socketPath = join(root, "agent.sock");
	const logPath = join(root, "commands.log");
	const configPath = join(root, "config.json");
	const hostPath = join(root, "host.mjs");
	const controlUrl = pathToFileURL(join(import.meta.dir, "attached-agent-bridge.mjs")).href;
	writeFileSync(configPath, JSON.stringify({ socketPath }));
	writeFileSync(
		hostPath,
		`import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(logPath)};
const handlers = new Map();
const emit = async (name, event = {}, ctx) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
const context = {
  sessionManager: {
    getSessionId: () => "child",
    getSessionFile: () => "/tmp/child.jsonl",
  },
  abort: () => appendFileSync(log, "abort\\n"),
  shutdown: () => {
    appendFileSync(log, "stop\\n");
    setTimeout(() => process.exit(0), 10);
  },
};
const run = async (delay = 0) => {
  await emit("agent_start");
  await emit("message_start", { message: { role: "assistant", content: [] } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "done" } });
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
  await emit("turn_end", {});
  await emit("agent_settled");
};
const pi = {
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  sendUserMessage(message, options) {
    if (options?.deliverAs === "steer") {
      appendFileSync(log, "steer:" + message + "\\n");
      return;
    }
    appendFileSync(log, "prompt:" + message + "\\n");
    void run();
  },
};
const control = (await import(${JSON.stringify(controlUrl)})).default;
control(pi);
await emit("session_start", {}, context);
setTimeout(() => void run(500), 500);`,
	);
	const child = spawn(process.execPath, [hostPath], {
		env: { ...process.env, PI_ATTACHED_AGENT_CONFIG: configPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const socket = await connect(socketPath);
	const next = messages(socket);

	expect((await next("ready")).state.sessionId).toBe("child");
	expect(existsSync(configPath)).toBe(false);
	await next("event");
	let reconnectedState: unknown;
	let inheritedResult: unknown;
	let resolveInherited = () => {};
	const inheritedCompletion = new Promise<void>((resolve) => {
		resolveInherited = resolve;
	});
	const controller = await connectAttachedAgent(
		{
			mode: "terminal",
			sessionName: "agent",
			socketPath,
			command: "true",
			args: [],
		},
		(state) => {
			reconnectedState = state;
		},
		(result) => {
			if (result.type !== "result") return;
			inheritedResult = result;
			resolveInherited();
		},
	);
	expect(reconnectedState).toMatchObject({ streaming: true });
	expect(await next("result")).toMatchObject({ turnId: "initial", responseText: "done" });
	await inheritedCompletion;
	expect(inheritedResult).toMatchObject({ turnId: "initial", responseText: "done" });
	const lateController = await connectAttachedAgent({
		mode: "terminal",
		sessionName: "agent",
		socketPath,
		command: "true",
		args: [],
	});
	expect(await (lateController as { start(): Promise<{ responseText: string }> }).start()).toEqual({
		responseText: "done",
	});
	await controller.steer("reconnected");
	expect(await controller.run("again")).toEqual({ responseText: "done" });
	socket.write('{"type":"steer","message":"change"}\n');
	socket.write('{"type":"abort"}\n');
	socket.write("{bad json}\n");
	expect((await next("error")).error).toContain("Invalid control message");
	await controller.stop();
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	for (let attempt = 0; attempt < 20 && !controller.closed; attempt++) await Bun.sleep(10);
	expect(controller.closed).toBe(true);
	await expect(controller.run("closed")).rejects.toThrow("control channel is closed");

	const log = readFileSync(logPath, "utf8");
	expect(log).toContain("steer:reconnected\nprompt:again\n");
	expect(log).toContain("steer:change\nabort\nstop\n");
});
