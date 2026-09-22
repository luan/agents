import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NestedToolAdapter, RuntimeResponse, ToolExecutionContext } from "../../src/protocol/types.ts";
import { CodeModeDelegateRuntime, normalizeToolResult } from "../../src/runtime/delegation.ts";

describe("nested tool result normalization", () => {
	test("returns plain text when no structured result exists", () => {
		expect(
			normalizeToolResult({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
				details: undefined,
			}),
		).toBe("one\ntwo");
	});

	test("returns details once when details exist", () => {
		const details = { exitCode: 0, output: "done" };
		expect(normalizeToolResult({ content: [{ type: "text", text: "done" }], details })).toBe(details);
	});

	test("keeps an adapter's JavaScript value separate from presentation details", () => {
		const details = { contract: "tool-presentation", progress: { output: "done" } };
		expect(
			normalizeToolResult({ content: [{ type: "text", text: "done" }], details }, () => ({
				output: "done",
				exit_code: 0,
			})),
		).toEqual({ output: "done", exit_code: 0 });
	});

	test("preserves image content and optional details", () => {
		const result = {
			content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
			details: { path: "/tmp/image.png" },
		};
		expect(normalizeToolResult(result)).toEqual(result);
	});
});

describe("nested tool trace lifecycle", () => {
	test("returns native image data to JavaScript without implicitly emitting it", async () => {
		const imageData = "A".repeat(70_000);
		let sent: unknown;
		let resolveResponse: (() => void) | undefined;
		const responseSent = new Promise<void>((resolve) => {
			resolveResponse = resolve;
		});
		const runtime = new CodeModeDelegateRuntime((message) => {
			sent = message;
			resolveResponse?.();
		});
		const adapter: NestedToolAdapter = {
			name: "view_image",
			kind: "function",
			parameters: { type: "object" },
			async invoke() {
				return {
					content: [{ type: "image", data: imageData, mimeType: "image/png" }],
					details: { path: "/tmp/image.png" },
				};
			},
		};
		const cellId = "cell-image";
		runtime.bindCell(
			cellId,
			{ cwd: process.cwd(), toolCallId: "exec-image", extensionContext: {} as ExtensionContext },
			new Map([[adapter.name, adapter]]),
		);
		runtime.handleRequest({
			id: 3,
			request: {
				type: "tool/invoke",
				invocation: {
					cell_id: cellId,
					input: { path: "/tmp/image.png" },
					runtime_tool_call_id: "runtime-image",
					tool_name: { name: adapter.name },
				},
			},
		});
		await responseSent;

		expect(sent).toMatchObject({
			result: { value: { result: { content: [{ type: "image", data: imageData, mimeType: "image/png" }] } } },
		});
		const attached = runtime.attach({ kind: "result", cellId, contentItems: [] });
		expect(attached.contentItems).toEqual([]);
		expect(attached.nestedCalls?.[0]?.result?.content).toEqual([
			{ type: "image", mimeType: "image/png", dataChars: imageData.length },
		]);
	});

	test("keeps terminal traces until the response attaches after cell close", async () => {
		let resolveResponse: (() => void) | undefined;
		const responseSent = new Promise<void>((resolve) => {
			resolveResponse = resolve;
		});
		const runtime = new CodeModeDelegateRuntime(() => resolveResponse?.());
		const adapter: NestedToolAdapter = {
			name: "echo",
			kind: "function",
			parameters: { type: "object" },
			async invoke(input) {
				return { content: [{ type: "text", text: String(input) }], details: undefined };
			},
		};
		const context: ToolExecutionContext = {
			cwd: process.cwd(),
			toolCallId: "exec-test",
			extensionContext: {} as ExtensionContext,
		};
		const cellId = "cell-1";
		runtime.bindCell(cellId, context, new Map([[adapter.name, adapter]]));
		runtime.handleRequest({
			id: 1,
			request: {
				type: "tool/invoke",
				invocation: {
					cell_id: cellId,
					input: "one",
					runtime_tool_call_id: "runtime-call-1",
					tool_name: { name: adapter.name },
				},
			},
		});
		await responseSent;

		runtime.closeCell(cellId);
		const response: RuntimeResponse = { kind: "result", cellId, contentItems: [] };
		expect(runtime.attach(response)).toMatchObject({
			nestedCalls: [
				{
					name: "echo",
					kind: "function",
					input: "one",
					status: "done",
					result: { content: [{ type: "text", text: "one" }] },
				},
			],
		});
	});
});

test.each([
	["cancel", false],
	["cancel", true],
	["clear", false],
	["clear", true],
] as const)("%s suppresses late nested tool output (failure: %j)", async (action, fail) => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const sent: object[] = [];
	let updates = 0;
	let aborted = false;
	const runtime = new CodeModeDelegateRuntime((message) => {
		if (message !== null && typeof message === "object") sent.push(message);
	});
	const adapter: NestedToolAdapter = {
		name: "deferred",
		kind: "function",
		parameters: { type: "object" },
		async invoke(_input, context, signal) {
			started.resolve();
			await finish.promise;
			aborted = signal.aborted;
			const result = { content: [{ type: "text" as const, text: "late" }], details: undefined };
			context.onUpdate?.(result);
			if (fail) throw new Error("late failure");
			return result;
		},
	};
	runtime.bindCell(
		"cell",
		{
			cwd: process.cwd(),
			toolCallId: "exec-cancel",
			extensionContext: {} as ExtensionContext,
			onUpdate: () => {
				updates++;
			},
		},
		new Map([[adapter.name, adapter]]),
	);
	runtime.handleRequest({
		id: 7,
		request: {
			type: "tool/invoke",
			invocation: {
				cell_id: "cell",
				input: {},
				runtime_tool_call_id: "nested",
				tool_name: { name: adapter.name },
			},
		},
	});
	await started.promise;
	const before = updates;
	if (action === "cancel") runtime.cancel(7);
	else runtime.clear();
	finish.resolve();
	await setImmediate();
	expect(aborted).toBe(true);
	expect(updates).toBe(before);
	expect(sent).toEqual([]);
});
