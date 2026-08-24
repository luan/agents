import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodeModeHostBinary } from "../../src/host/binary.ts";
import { CodeModeHostClient } from "../../src/host/client.ts";
import type { NestedToolAdapter, RuntimeResponse, ToolExecutionContext } from "../../src/protocol/types.ts";

const clients: CodeModeHostClient[] = [];

function client(): CodeModeHostClient {
	const value = new CodeModeHostClient({ binary: resolveCodeModeHostBinary(), shutdownGraceMs: 1_000 });
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
		const delayed: NestedToolAdapter = {
			name: "delayed",
			kind: "function",
			parameters: { type: "object" },
			async invoke(input) {
				active++;
				maximum = Math.max(maximum, active);
				await Bun.sleep(25);
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
		const execution = host.execute("while (true) {}", context(), [], controller.signal);
		setTimeout(() => controller.abort(), 25);

		await expect(execution).rejects.toMatchObject({ name: "AbortError" });
		await host.shutdown();
	}, 10_000);
});
