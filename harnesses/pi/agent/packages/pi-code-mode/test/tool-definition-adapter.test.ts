import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { codeModeFunctionToolAdapter } from "../src/protocol/tool-definition-adapter.ts";

const PARAMETERS = Type.Object({ path: Type.String() });
const theme = {} as Theme;

describe("ToolDefinition Code Mode adapter", () => {
	test("reuses the owning tool renderers for call and result presentation", () => {
		let resultRenders = 0;
		let executionStarted: boolean | undefined;
		const tool: ToolDefinition<typeof PARAMETERS, { durationMs: number }, { resultRenders?: number }> = {
			name: "image_tool",
			label: "image_tool",
			description: "View an image",
			parameters: PARAMETERS,
			renderCall(args, _theme, context) {
				executionStarted = context.executionStarted;
				return component(`call:${args.path}`);
			},
			renderResult(result, _options, _theme, context) {
				resultRenders += 1;
				context.state.resultRenders = resultRenders;
				return component(`result:${context.args.path}:${result.details.durationMs}:${context.cwd}`);
			},
			async execute() {
				return { content: [], details: { durationMs: 5 } };
			},
		};
		const adapter = codeModeFunctionToolAdapter(tool);
		const state = {};
		const call = adapter.renderTrace?.(
			{ id: "call", input: { path: "image.png" }, status: "running" },
			{ theme, requestRender() {}, executionStarted: true, cwd: "/tmp", state, lastComponent: undefined },
		);
		expect(call?.render(80)).toEqual(["call:image.png"]);
		expect(executionStarted).toBe(true);

		const result = adapter.renderTrace?.(
			{
				id: "call",
				input: { path: "image.png" },
				status: "done",
				result: { content: [{ type: "text", text: "ok" }], details: { durationMs: 5 } },
			},
			{ theme, requestRender() {}, executionStarted: true, cwd: "/tmp", state, lastComponent: call },
		);
		expect(result?.render(80)).toEqual(["result:image.png:5:/tmp"]);
		expect(state).toEqual({ resultRenders: 1 });
	});

	test("leaves rejected traces without results to Code Mode's failure renderer", () => {
		let callRenders = 0;
		const tool: ToolDefinition<typeof PARAMETERS, { durationMs: number }> = {
			name: "image_tool",
			label: "image_tool",
			description: "View an image",
			parameters: PARAMETERS,
			renderCall() {
				callRenders += 1;
				return component("queued");
			},
			async execute() {
				return { content: [], details: { durationMs: 5 } };
			},
		};

		const rendered = codeModeFunctionToolAdapter(tool).renderTrace?.(
			{ id: "call", input: { path: "missing.png" }, status: "error", error: "not found" },
			{ theme, requestRender() {}, executionStarted: true, cwd: "/tmp", state: {}, lastComponent: undefined },
		);

		expect(rendered).toBeUndefined();
		expect(callRenders).toBe(0);
	});

	test("preserves restored transcript state for owning tool renderers", () => {
		let executionStarted: boolean | undefined;
		const tool: ToolDefinition<typeof PARAMETERS, { durationMs: number }> = {
			name: "image_tool",
			label: "image_tool",
			description: "View an image",
			parameters: PARAMETERS,
			renderResult(_result, _options, _theme, context) {
				executionStarted = context.executionStarted;
				return component("restored");
			},
			async execute() {
				return { content: [], details: { durationMs: 5 } };
			},
		};

		codeModeFunctionToolAdapter(tool).renderTrace?.(
			{
				id: "call",
				input: { path: "image.png" },
				status: "done",
				result: { content: [], details: { durationMs: 5 } },
			},
			{ theme, requestRender() {}, executionStarted: false, cwd: "/tmp", state: {}, lastComponent: undefined },
		);

		expect(executionStarted).toBe(false);
	});

	test("forwards execution through the same ToolDefinition", async () => {
		let observed: string | undefined;
		const tool: ToolDefinition<typeof PARAMETERS, { durationMs: number }> = {
			name: "image_tool",
			label: "image_tool",
			description: "View an image",
			parameters: PARAMETERS,
			async execute(_id, input) {
				observed = input.path;
				return { content: [], details: { durationMs: 5 } };
			},
		};
		const result = await codeModeFunctionToolAdapter(tool).invoke(
			{ path: "image.png" },
			{
				cwd: "/tmp",
				toolCallId: "call",
				extensionContext: {} as ExtensionContext,
			},
			new AbortController().signal,
		);
		expect(observed).toBe("image.png");
		expect((result as AgentToolResult<{ durationMs: number }>).details.durationMs).toBe(5);
	});
});

function component(line: string) {
	return { render: () => [line], invalidate() {} };
}
