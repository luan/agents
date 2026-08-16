import { expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createIsolatedNodePtyBackend } from "./isolated-node-pty-backend.ts";
import type { PtyProcess } from "./pty-backend.ts";

class FakeHost extends EventEmitter {
	readonly pid = 9001;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly commands: any[] = [];
	readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
	#inputBuffer = "";

	constructor(onCommand?: (command: any, host: FakeHost) => void) {
		super();
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (data: string) => {
			this.#inputBuffer += data;
			while (true) {
				const newline = this.#inputBuffer.indexOf("\n");
				if (newline < 0) break;
				const command = JSON.parse(this.#inputBuffer.slice(0, newline));
				this.#inputBuffer = this.#inputBuffer.slice(newline + 1);
				this.commands.push(command);
				onCommand?.(command, this);
			}
		});
	}

	send(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	sendRaw(data: string): void {
		this.stdout.write(data);
	}

	close(code: number): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, null);
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killSignals.push(signal);
		return true;
	}

	asChild(): ChildProcessWithoutNullStreams {
		return this as unknown as ChildProcessWithoutNullStreams;
	}
}

const SPAWN_OPTIONS = {
	cwd: "/tmp",
	env: { PATH: process.env.PATH, TERM: "xterm-256color" },
	name: "xterm-256color",
	cols: 80,
	rows: 24,
};

function exitOf(processHandle: PtyProcess): Promise<{ exitCode: number; sessionError?: string }> {
	return new Promise((resolve) => processHandle.onExit(resolve));
}

test("the adapter replays output and exit events that arrive before listeners attach", async () => {
	const host = new FakeHost((command, currentHost) => {
		if (command.type !== "spawn") return;
		currentHost.send({ type: "ready", pid: 42 });
		currentHost.send({ type: "output", data: "first" });
		currentHost.send({ type: "output", data: "second" });
		currentHost.send({ type: "exit", exitCode: 7 });
		currentHost.close(0);
	});
	const processHandle = await createIsolatedNodePtyBackend({ spawnHost: () => host.asChild() }).spawn(
		"/bin/sh",
		["-c", "ignored"],
		SPAWN_OPTIONS,
	);

	let output = "";
	processHandle.onData((data) => (output += data));
	const exit = await exitOf(processHandle);

	expect(processHandle.pid).toBe(42);
	expect(output).toBe("firstsecond");
	expect(exit).toEqual({ exitCode: 7 });
	expect(host.commands[0]).toMatchObject({
		type: "spawn",
		file: "/bin/sh",
		args: ["-c", "ignored"],
		cwd: "/tmp",
		name: "xterm-256color",
		cols: 80,
		rows: 24,
	});
});

test("the adapter forwards input and resize commands", async () => {
	const host = new FakeHost((command, currentHost) => {
		if (command.type === "spawn") currentHost.send({ type: "ready", pid: 43 });
	});
	const processHandle = await createIsolatedNodePtyBackend({ spawnHost: () => host.asChild() }).spawn(
		"/bin/sh",
		[],
		SPAWN_OPTIONS,
	);

	await processHandle.write("hello\n");
	await processHandle.resize(101, 43);

	expect(host.commands.slice(1)).toEqual([
		{ type: "input", data: "hello\n" },
		{ type: "resize", cols: 101, rows: 43 },
	]);
});

test("the adapter escalates termination after the grace period", async () => {
	const host = new FakeHost((command, currentHost) => {
		if (command.type === "spawn") currentHost.send({ type: "ready", pid: 44 });
	});
	const processHandle = await createIsolatedNodePtyBackend({
		spawnHost: () => host.asChild(),
		forceKillDelayMs: 5,
	}).spawn("/bin/sh", [], SPAWN_OPTIONS);

	processHandle.kill();
	await Bun.sleep(70);

	expect(host.commands.slice(1)).toEqual([
		{ type: "terminate", signal: "SIGTERM" },
		{ type: "terminate", signal: "SIGKILL" },
	]);
	expect(host.killSignals).toEqual(["SIGKILL"]);
});

test("an unexpected host exit becomes a session error", async () => {
	const host = new FakeHost((command, currentHost) => {
		if (command.type === "spawn") currentHost.send({ type: "ready", pid: 45 });
	});
	const processHandle = await createIsolatedNodePtyBackend({ spawnHost: () => host.asChild() }).spawn(
		"/bin/sh",
		[],
		SPAWN_OPTIONS,
	);
	host.close(9);

	expect(await exitOf(processHandle)).toEqual({
		exitCode: 9,
		sessionError: "the isolated PTY host exited unexpectedly",
	});
});

test("malformed host output after ready becomes a session error", async () => {
	const host = new FakeHost((command, currentHost) => {
		if (command.type === "spawn") currentHost.send({ type: "ready", pid: 46 });
	});
	const processHandle = await createIsolatedNodePtyBackend({ spawnHost: () => host.asChild() }).spawn(
		"/bin/sh",
		[],
		SPAWN_OPTIONS,
	);
	host.sendRaw("not-json\n");

	expect(await exitOf(processHandle)).toEqual({
		exitCode: 1,
		sessionError: "the isolated PTY host sent malformed output",
	});
	expect(host.killSignals).toEqual(["SIGKILL"]);
});
