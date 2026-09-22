import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodeModeHostBinary } from "../../src/host/binary.ts";
import { CodeModeHostClient } from "../../src/host/client.ts";
import { CodeModeHostConnection } from "../../src/host/connection.ts";
import type { HostMessage } from "../../src/host/protocol.ts";
import type { NestedToolAdapter, RuntimeResponse, ToolExecutionContext } from "../../src/protocol/types.ts";

const clients: CodeModeHostClient[] = [];

function client(): CodeModeHostClient {
	const value = new CodeModeHostClient({ binary: resolveCodeModeHostBinary, shutdownGraceMs: 1_000 });
	clients.push(value);
	return value;
}

function context(toolCallId = "exec-test"): ToolExecutionContext {
	return {
		cwd: process.cwd(),
		toolCallId,
		extensionContext: { cwd: process.cwd() } as ExtensionContext,
	};
}

function textItems(response: RuntimeResponse): string[] {
	return response.contentItems.flatMap((item) => (item.type === "input_text" && item.text ? [item.text] : []));
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((value) => value.shutdown()));
});

describe("TypeScript client to release host", () => {
	test("executes restricted JavaScript and returns text", async () => {
		const response = await client().execute('text("hello")', context(), []);

		expect(response.kind).toBe("result");
		expect(textItems(response)).toEqual(["hello"]);
	}, 10_000);

	test("invokes function and freeform adapters", async () => {
		const calls: unknown[] = [];
		const updates: string[] = [];
		const tools: NestedToolAdapter[] = [
			{
				name: "echo",
				kind: "function",
				parameters: { type: "object" },
				async invoke(input) {
					calls.push(input);
					return {
						content: [{ type: "text", text: `function:${(input as { value: string }).value}` }],
						details: undefined,
					};
				},
			},
			{
				name: "patch",
				kind: "freeform",
				async invoke(input) {
					calls.push(input);
					return { content: [{ type: "text", text: `freeform:${String(input)}` }], details: undefined };
				},
			},
		];
		const response = await client().execute(
			'const a = await tools.echo({value:"one"}); const b = await tools.patch("two"); text(a); text(b);',
			{
				...context(),
				onUpdate(update) {
					updates.push(update.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"));
				},
			},
			tools,
		);

		expect(calls).toEqual([{ value: "one" }, "two"]);
		expect(textItems(response)).toEqual(["function:one", "freeform:two"]);
		expect(updates).toContain("• Running echo");
		expect(updates.at(-1)).toBe("• Ran echo\n• Ran patch");
		expect(response.nestedCalls).toMatchObject([
			{
				version: 1,
				name: "echo",
				kind: "function",
				input: { value: "one" },
				status: "done",
				result: { content: [{ type: "text", text: "function:one" }] },
			},
			{
				version: 1,
				name: "patch",
				kind: "freeform",
				input: "two",
				status: "done",
				result: { content: [{ type: "text", text: "freeform:two" }] },
			},
		]);
		expect(response.nestedCalls?.every((trace) => trace.durationMs !== undefined)).toBe(true);
	}, 10_000);

	test("returns an adapter value without leaking presentation details into JavaScript", async () => {
		const tool: NestedToolAdapter = {
			name: "structured",
			kind: "function",
			parameters: { type: "object" },
			async invoke() {
				return {
					content: [{ type: "text", text: "command output" }],
					details: { contract: "tool-presentation", progress: { output: "command output" } },
				};
			},
			resultValue() {
				return { output: "command output", exit_code: 0 };
			},
		};
		const response = await client().execute("text(await tools.structured({}))", context(), [tool]);

		expect(textItems(response)).toEqual(['{"exit_code":0,"output":"command output"}']);
		expect(textItems(response).join("\n")).not.toContain("tool-presentation");
		expect(response.nestedCalls?.[0]?.result?.details).toMatchObject({ contract: "tool-presentation" });
		expect(response.nestedCalls?.[0]?.value).toEqual({ output: "command output", exit_code: 0 });
	}, 10_000);

	test("runs independent nested calls in parallel", async () => {
		let active = 0;
		let maximum = 0;
		const bothStarted = Promise.withResolvers<void>();
		const delayed: NestedToolAdapter = {
			name: "delayed",
			kind: "function",
			parameters: { type: "object" },
			async invoke(input) {
				active++;
				maximum = Math.max(maximum, active);
				if (active === 2) bothStarted.resolve();
				await bothStarted.promise;
				active--;
				return { content: [{ type: "text", text: (input as { value: string }).value }], details: undefined };
			},
		};
		const response = await client().execute(
			'const values = await Promise.all([tools.delayed({value:"a"}), tools.delayed({value:"b"})]); text(values.join(","));',
			context(),
			[delayed],
		);

		expect(maximum).toBe(2);
		expect(textItems(response)).toEqual(["a,b"]);
	}, 10_000);

	test("shares stored values across cells in one host session", async () => {
		const host = client();
		await host.execute('store("answer", {value: 42}); text("stored")', context("store"), []);
		const response = await host.execute('text(load("answer").value)', context("load"), []);

		expect(textItems(response)).toEqual(["42"]);
	}, 10_000);

	test("yields a cell and resumes it with wait", async () => {
		const host = client();
		const yielded = await host.execute('text("before"); yield_control(); text("after")', context(), []);

		expect(yielded.kind).toBe("yielded");
		expect(textItems(yielded)).toEqual(["before"]);
		const completed = await host.wait(yielded.cellId, 1_000, context("wait"));
		expect(completed.kind).toBe("result");
		expect(textItems(completed)).toEqual(["after"]);
	}, 10_000);

	test("terminates a yielded cell", async () => {
		const host = client();
		const yielded = await host.execute("yield_control(); await new Promise(() => {})", context(), []);
		const terminated = await host.terminate(yielded.cellId, context("terminate"));

		expect(yielded.kind).toBe("yielded");
		expect(terminated.kind).toBe("terminated");
	}, 10_000);

	test("aborts active execution and shuts down the host", async () => {
		const host = client();
		const controller = new AbortController();
		const execution = host.execute(
			'await notify("ready"); while (true) {}',
			{
				...context(),
				onUpdate(update) {
					if (update.content.some((item) => item.type === "text" && item.text === "ready")) controller.abort();
				},
			},
			[],
			controller.signal,
		);

		await expect(execution).rejects.toMatchObject({ name: "AbortError" });
		await host.shutdown();
	}, 10_000);
});

test("shutdown cancels pending host startup and prevents reuse of the closed client", async () => {
	const binary = Promise.withResolvers<string>();
	const host = new CodeModeHostClient({ binary: () => binary.promise });
	clients.push(host);
	const starting = host.start();
	const outcome = starting.then(
		() => "started",
		(error: Error) => error.message,
	);
	await host.shutdown();
	binary.resolve(await resolveCodeModeHostBinary());
	expect(await outcome).toMatch(/cancelled|shut down/i);
	await expect(host.start()).rejects.toThrow("shut down");
});

test("failed binary discovery can be retried before shutdown", async () => {
	let attempts = 0;
	const host = new CodeModeHostClient({
		binary: async () => {
			if (++attempts === 1) throw new Error("binary unavailable");
			return resolveCodeModeHostBinary();
		},
	});
	clients.push(host);
	await expect(host.start()).rejects.toThrow("binary unavailable");
	const result = await host.execute('text("recovered")', context(), []);
	expect(textItems(result)).toEqual(["recovered"]);
	expect(attempts).toBe(2);
});

test.each(["execute", "wait"] as const)(
	"cancelling %s does not wait for or cancel shared host startup",
	async (operation) => {
		const binary = Promise.withResolvers<string>();
		const host = new CodeModeHostClient({ binary: () => binary.promise });
		clients.push(host);
		const controller = new AbortController();
		let cancelled = false;
		const first = (
			operation === "execute"
				? host.execute('store("cancelled", true)', context("cancelled"), [], controller.signal)
				: host.wait("missing", 0, context("cancelled"), controller.signal)
		).catch((error: Error) => {
			cancelled = error.name === "AbortError";
		});
		const second = host.execute('text(load("cancelled") ?? "kept")', context("kept"), []);
		void second.catch(() => {});
		try {
			controller.abort();
			await setImmediate();
			expect(cancelled).toBe(true);
			binary.resolve(await resolveCodeModeHostBinary());
			expect(textItems(await second)).toEqual(["kept"]);
			await first;
		} finally {
			binary.resolve(await resolveCodeModeHostBinary());
			await host.shutdown();
			await Promise.allSettled([first, second]);
		}
	},
);

test.each(["source", "schema"] as const)("rejects invalid %s before starting the host", async (invalid) => {
	let attempts = 0;
	const host = new CodeModeHostClient({
		binary: async () => {
			attempts++;
			throw new Error("unexpected host startup");
		},
	});
	clients.push(host);
	const tool: NestedToolAdapter = {
		name: "invalid",
		kind: "function",
		invoke: async () => ({ content: [], details: undefined }),
	};
	await expect(
		host.execute(invalid === "source" ? " " : 'text("ok")', context(), invalid === "schema" ? [tool] : []),
	).rejects.toThrow(invalid === "source" ? "non-empty" : "inputSchema");
	expect(attempts).toBe(0);
});

test.each(["stdin", "stdout", "stderr"] as const)(
	"host %s failure rejects execution and permits recovery",
	async (pipe) => {
		const spawned = spyOn(childProcess, "spawn");
		const host = client();
		let child: childProcess.ChildProcess | undefined;
		try {
			await host.start();
			const result = spawned.mock.results[0];
			if (result?.type !== "return") throw new Error("host child was not spawned");
			child = result.value;
			spawned.mockRestore();
			const ready = Promise.withResolvers<void>();
			let failure: string | undefined;
			const execution = host
				.execute(
					'await notify("ready"); await new Promise(() => {})',
					{
						...context(),
						onUpdate: () => ready.resolve(),
					},
					[],
				)
				.catch((error: Error) => {
					failure = error.message;
				});
			await ready.promise;
			expect(() => child?.[pipe]?.emit("error", new Error("host pipe failed"))).not.toThrow();
			await setImmediate();
			expect(failure).toBe("host pipe failed");
			await execution;
			const recovered = await host.execute('text("recovered")', context(), []);
			expect(textItems(recovered)).toEqual(["recovered"]);
		} finally {
			spawned.mockRestore();
			child?.kill("SIGKILL");
			await host.shutdown();
		}
	},
);

test.each(["{", "null"])("a rejected frame discards subsequent buffered events: %s", async (invalid) => {
	const spawned = spyOn(childProcess, "spawn");
	const messages: HostMessage[] = [];
	const failures: Error[] = [];
	const connection = new CodeModeHostConnection({
		binary: resolveCodeModeHostBinary,
		onMessage: (message) => messages.push(message),
		onFailure: (error) => failures.push(error),
	});
	try {
		await connection.start();
		const child = spawned.mock.results[0];
		if (child?.type !== "return" || !child.value.stdout) throw new Error("host child was not spawned");
		spawned.mockRestore();
		const frames = [invalid, JSON.stringify({ type: "cell/closed", cellId: "stale" })].map((text) => {
			const payload = Buffer.from(text);
			const header = Buffer.alloc(4);
			header.writeUInt32LE(payload.length);
			return Buffer.concat([header, payload]);
		});
		child.value.stdout.emit("data", Buffer.concat(frames));
		expect(failures).toHaveLength(1);
		expect(messages).toEqual([]);
		await connection.start();
		expect(connection.running).toBe(true);
	} finally {
		spawned.mockRestore();
		connection.close(new Error("test complete"));
	}
});
