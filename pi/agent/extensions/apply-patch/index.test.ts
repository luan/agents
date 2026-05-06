import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeOpenAICodexWebSocketSessions,
	convertTools,
	getOpenAICodexWebSocketDebugStats,
	mapFreeformEvents,
	parseSSE,
	registerApplyPatchFreeformProvider,
	resetOpenAICodexWebSocketDebugStats,
} from "./freeform-codex.ts";
import applyPatchExtension from "./index.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

const resolvedDiff = `--- a/sample.js
+++ b/sample.js
@@ -1,8 +1,8 @@
 function renderSummary(summary) {
  const lines = [
   \`total words: \${summary.totalWords}\`,
   \`unique words: \${summary.uniqueWords}\`,
-  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} occurrences)\`,
+  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} hits)\`,
   \`last word: \${summary.lastWord ?? "(none)"}\`,
  ];
 }
`;

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
	getBgAnsi: () => undefined,
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function renderText(component: { render(width: number): string[] }, width = 140): string {
	return stripAnsi(component.render(width).join("\n"));
}

function registerApplyPatchTool(): any {
	let tool: any;
	const pi = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		getActiveTools: () => ["apply_patch"],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { emit: () => {} },
	};
	applyPatchExtension(pi as any);
	expect(tool?.name).toBe("apply_patch");
	return tool;
}

function registerApplyPatchCommands() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => {
			handlers.set(name, handler);
		},
		registerCommand: (name: string, definition: any) => {
			commands.set(name, definition);
		},
		registerTool: () => {},
		getActiveTools: () => ["apply_patch"],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { emit: () => {} },
	};
	applyPatchExtension(pi as any);
	return { commands, handlers };
}

function renderContext(cwd: string, state: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "test-call",
		invalidate: () => {},
		lastComponent: undefined,
		state,
		cwd,
		executionStarted: false,
		argsComplete: false,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("apply_patch streaming renderer", () => {
	it("streams authored diff rows immediately before preview worker line-number upgrade", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-render-"));
		writeFileSync(
			join(cwd, "sample.js"),
			[
				"function renderSummary(summary) {",
				"const lines = [",
				"  `total words: $" + "{summary.totalWords}`,",
				"  `unique words: $" + "{summary.uniqueWords}`,",
				"  `most common character: $" +
					'{summary.mostCommonCharacter?.char ?? "(none)"} ($' +
					"{summary.mostCommonCharacter?.count ?? 0} occurrences)`,",
				"  `last word: $" + '{summary.lastWord ?? "(none)"}`,',
				"  ];",
				"}",
				"",
			].join("\n"),
		);

		const patchInput = `*** Begin Patch
*** Update File: sample.js
@@
-  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} occurrences)\`,
+  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} hits)\`,
*** End Patch
`;

		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const first = tool.renderCall({ input: patchInput }, theme, renderContext(cwd, state, { argsComplete: false }));
		const firstText = renderText(first);
		expect(firstText).toContain("sample.js");
		expect(firstText).toContain("occurrences)");
		expect(firstText).toContain("hits)");
		expect(firstText).not.toContain("5 -");
		expect(firstText).not.toContain("5 +");

		await delay(1500);

		const second = tool.renderCall({ input: patchInput }, theme, renderContext(cwd, state, { argsComplete: false }));
		const secondText = renderText(second);

		expect(secondText).toContain("Editing sample.js (+1 -1)");
		expect(secondText).toContain("5 -");
		expect(secondText).toContain("5 +");
		expect(secondText).toContain("occurrences)");
		expect(secondText).toContain("hits)");

		const executionStarted = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		expect(renderText(executionStarted)).toContain("Editing sample.js (+1 -1)");

		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "M sample.js" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [{ path: "sample.js", operation: "update", added: 1, removed: 1 }],
					diff: resolvedDiff,
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		expect(renderText(result)).toContain("Edited sample.js (+1 -1)");
		expect(renderText(executionStarted)).toBe("");

		tool.renderCall({ input: patchInput }, theme, renderContext(cwd, state, { argsComplete: true }));
	});

	it("renders patch intent before the diff", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-intent-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "M sample.js" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [{ path: "sample.js", operation: "update", added: 1, removed: 1 }],
					diff: resolvedDiff,
					intent: "Make the summary wording shorter.",
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);

		const text = renderText(result);
		expect(text).toContain("Intent: Make the summary wording shorter.");
		expect(text.indexOf("Intent:")).toBeLessThan(text.indexOf("• Edited sample.js"));
	});

	it("keeps completed call renderers hidden on later invalidations", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-completed-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = { resultRendered: true };
		const patchInput = `*** Begin Patch
*** Update File: sample.js
@@
-old
+new
*** End Patch
`;

		const rendered = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);

		expect(renderText(rendered)).toBe("");
		expect(state.livePreview).toBeUndefined();
	});

	it("does not render historical patch calls while final results are attached", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-history-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const patchInput = `*** Begin Patch
*** Update File: sample.js
@@
-old
+new
*** End Patch
`;

		const initial = tool.renderCall({ input: patchInput }, theme, renderContext(cwd, state, { argsComplete: false }));
		expect(renderText(initial)).toContain("new");

		const finalizing = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false, isPartial: false }),
		);

		expect(renderText(finalizing)).toBe("");
	});

	it("renders semantic hunks as separate semantic editing blocks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-semantic-render-"));
		writeFileSync(
			join(cwd, "sample.js"),
			["function alpha() {", "  return 1;", "}", "", "function beta() {", "  return 2;", "}", ""].join("\n"),
		);

		const patchInput = `*** Begin Patch
*** Update Scope: sample.js
@@ function alpha
-  return 1;
+  return 10;
*** Update Scope: sample.js
@@ function beta
-  return 2;
+  return 20;
*** End Patch
`;

		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const immediate = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
		const immediateText = renderText(immediate);
		expect(immediateText).toContain("Semantic editing sample.js");
		expect(immediateText).toContain("return 10;");
		expect(immediateText).toContain("return 20;");

		await delay(1500);

		const rendered = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
		const text = renderText(rendered);

		expect(text).toContain("Semantic editing sample.js › function alpha");
		expect(text).toContain("Semantic editing sample.js › function beta");
		expect(text.match(/Semantic editing sample\.js/g)?.length).toBe(2);
		expect(text).toContain("2 +   return 10;");
		expect(text).toContain("6 +   return 20;");

		const semanticDiff = `--- a/sample.js
+++ b/sample.js
@@ -1,7 +1,7 @@
 function alpha() {
-  return 1;
+  return 10;
 }
 
 function beta() {
-  return 2;
+  return 20;
 }
`;
		const highlightedDiffRows = [
			{
				kind: "hunk",
				oldLine: null,
				newLine: null,
				content: "@@ -1,7 +1,7 @@",
				path: "sample.js",
			},
			{
				kind: "context",
				oldLine: 1,
				newLine: 1,
				content: "function alpha() {",
				path: "sample.js",
				highlightedContent: "function alpha() {",
			},
			{
				kind: "remove",
				oldLine: 2,
				newLine: null,
				content: "  return 1;",
				path: "sample.js",
				highlightedContent: "  return 1;",
			},
			{
				kind: "add",
				oldLine: null,
				newLine: 2,
				content: "  return 10;",
				path: "sample.js",
				highlightedContent: "  return 10;",
			},
			{
				kind: "context",
				oldLine: 3,
				newLine: 3,
				content: "}",
				path: "sample.js",
				highlightedContent: "}",
			},
			{
				kind: "context",
				oldLine: 4,
				newLine: 4,
				content: "",
				path: "sample.js",
				highlightedContent: "",
			},
			{
				kind: "context",
				oldLine: 5,
				newLine: 5,
				content: "function beta() {",
				path: "sample.js",
				highlightedContent: "function beta() {",
			},
			{
				kind: "remove",
				oldLine: 6,
				newLine: null,
				content: "  return 2;",
				path: "sample.js",
				highlightedContent: "  return 2;",
			},
			{
				kind: "add",
				oldLine: null,
				newLine: 6,
				content: "  return 20;",
				path: "sample.js",
				highlightedContent: "  return 20;",
			},
			{
				kind: "context",
				oldLine: 7,
				newLine: 7,
				content: "}",
				path: "sample.js",
				highlightedContent: "}",
			},
		];
		const final = tool.renderResult(
			{
				content: [{ type: "text", text: "M sample.js" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [{ path: "sample.js", operation: "update", added: 2, removed: 2 }],
					diff: semanticDiff,
					highlightedDiffRows,
					semantic: true,
					previewChanges: [
						{
							path: "sample.js",
							type: "update",
							additions: 2,
							deletions: 2,
							scopes: [
								{ name: "alpha", kind: "function", start_line: 1, end_line: 3 },
								{ name: "beta", kind: "function", start_line: 5, end_line: 7 },
							],
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const finalText = renderText(final);
		expect(finalText).toContain("Semantic edited sample.js › function alpha");
		expect(finalText).toContain("Semantic edited sample.js › function beta");
	});

	it("wraps long apply failure text inside the rendered width", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-error-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const longError = [
			"Error: ambiguous context in pi/agent/extensions/lens/index.ts at chunk #0 — matched 6 location(s) at lines [268, 297, 312, 335, 344, 351]; widen the context or use a more specific @@ anchor",
			"suggested anchors:",
			"  @@ function eventFor(ctx: any, event: LensHookEventName, extra: Record<string, unknown> = {}) {  →  pins to candidate at line 268 (anchor at line 240)",
		].join("\n");

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: longError }],
				details: { stage: "apply" },
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const lines = renderText(rendered, 72).split("\n");
		expect(lines.every((line) => line.length <= 72)).toBe(true);
		expect(lines.join("\n")).toContain("widen the context");
		expect(lines.join("\n")).toContain("pins to candidate");
	});

	it("strips nested ANSI diff backgrounds from apply failure text", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-error-ansi-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const ansiError = [
			"Error: context not found",
			'\u001b[48;2;20;53;31m+import { readFileSync, statSync } from "node:fs";\u001b[0m',
			"\u001b[48;2;59;29;36m-function saveConfig(config: ApplyPatchConfig): void {\u001b[0m",
		].join("\n");

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: ansiError }],
				details: { stage: "apply" },
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const rawText = rendered.render(120).join("\n");
		expect(rawText).not.toContain("\u001b[48;2;20;53;31m");
		expect(rawText).not.toContain("\u001b[48;2;59;29;36m");
		expect(renderText(rendered)).toContain('+import { readFileSync, statSync } from "node:fs";');
		expect(renderText(rendered)).toContain("-function saveConfig(config: ApplyPatchConfig): void {");
	});
});

describe("apply_patch intent command", () => {
	it("registers /apply-patch-intents and removes /apply-patch-diff", () => {
		const { commands } = registerApplyPatchCommands();

		expect(commands.has("apply-patch-intents")).toBe(true);
		expect(commands.has("apply-patch-diff")).toBe(false);
	});

	it("shows session intents with optional stats", async () => {
		const { commands } = registerApplyPatchCommands();
		const notifications: string[] = [];
		const entries = [
			{
				message: {
					role: "toolResult",
					toolName: "apply_patch",
					isError: false,
					details: {
						intent: "Make the summary wording shorter.",
						fileDiffs: [{ path: "sample.js", operation: "update", added: 1, removed: 1 }],
					},
				},
			},
			{
				message: {
					role: "toolResult",
					toolName: "functions.apply_patch",
					isError: false,
					details: {
						intent: "Add command tests.",
						fileDiffs: [
							{ path: "index.test.ts", operation: "update", added: 12, removed: 0 },
							{ path: "index.ts", operation: "update", added: 3, removed: 1 },
						],
					},
				},
			},
		];

		await commands.get("apply-patch-intents").handler("session --stat", {
			sessionManager: { getBranch: () => entries },
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(notifications[0]).toBe(
			["- Make the summary wording shorter. — sample.js (+1 -1)", "- Add command tests. — 2 files (+15 -1)"].join(
				"\n",
			),
		);
	});

	it("shows last turn intents from the turn_end event", async () => {
		const { commands, handlers } = registerApplyPatchCommands();
		const notifications: string[] = [];

		handlers.get("turn_end")?.({
			toolResults: [
				{
					toolName: "apply_patch",
					isError: false,
					details: {
						intent: "Update runtime behavior.",
						fileDiffs: [{ path: "index.ts", operation: "update", added: 2, removed: 1 }],
					},
				},
			],
		});

		await commands.get("apply-patch-intents").handler("turn", {
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(notifications[0]).toBe("- Update runtime behavior.");
	});

	it("keeps last turn intents when a final assistant turn has no tool results", async () => {
		const { commands, handlers } = registerApplyPatchCommands();
		const notifications: string[] = [];

		handlers.get("agent_start")?.({});
		handlers.get("turn_end")?.({
			toolResults: [
				{
					toolName: "apply_patch",
					isError: false,
					details: {
						intent: "Update runtime behavior.",
						fileDiffs: [{ path: "index.ts", operation: "update", added: 2, removed: 1 }],
					},
				},
			],
		});
		handlers.get("turn_end")?.({ toolResults: [] });

		await commands.get("apply-patch-intents").handler("turn", {
			sessionManager: { getBranch: () => [] },
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(notifications[0]).toBe("- Update runtime behavior.");
	});

	it("finds last turn intents in branch entries before the final assistant message", async () => {
		const { commands } = registerApplyPatchCommands();
		const notifications: string[] = [];
		const entries = [
			{ message: { role: "user" } },
			{ message: { role: "assistant" } },
			{
				message: {
					role: "toolResult",
					toolName: "apply_patch",
					isError: false,
					details: {
						intent: "Update runtime behavior.",
						fileDiffs: [{ path: "index.ts", operation: "update", added: 2, removed: 1 }],
					},
				},
			},
			{ message: { role: "assistant" } },
		];

		await commands.get("apply-patch-intents").handler("turn", {
			sessionManager: { getBranch: () => entries },
			ui: { notify: (message: string) => notifications.push(message) },
		});

		expect(notifications[0]).toBe("- Update runtime behavior.");
	});
});

describe("apply_patch Codex tool policy", () => {
	it("blocks edit and write when the selected model is from the Codex provider", () => {
		type Handler = (...args: any[]) => any;
		const handlers = new Map<string, Handler>();
		const pi = {
			on: (name: string, handler: Handler) => {
				handlers.set(name, handler);
			},
			registerCommand: () => {},
			registerTool: () => {},
			getActiveTools: () => ["read", "edit", "write", "apply_patch"],
			setActiveTools: () => {},
			appendEntry: () => {},
			events: { emit: () => {} },
		};

		applyPatchExtension(pi as any);
		const handler = handlers.get("tool_call");
		expect(handler).toBeDefined();

		const ctx = { model: { provider: "openai-codex", id: "gpt-5.5" } };
		expect(handler?.({ toolName: "edit" }, ctx)?.block).toBe(true);
		expect(handler?.({ toolName: "write" }, ctx)?.block).toBe(true);
		expect(handler?.({ toolName: "read" }, ctx)).toBeUndefined();
	});
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

describe("apply_patch Codex freeform provider", () => {
	it("converts only apply_patch custom tool stream events", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 3,
				item: {
					id: "apply",
					type: "custom_tool_call",
					name: "apply_patch",
					input: "",
				},
			},
			{
				type: "response.output_item.added",
				item: {
					id: "other",
					type: "custom_tool_call",
					name: "other_tool",
					input: "",
				},
			},
			{
				type: "response.custom_tool_call_input.delta",
				item_id: "other",
				delta: "do-not-convert",
			},
			{
				type: "response.custom_tool_call_input.delta",
				output_index: 3,
				item_id: "apply",
				delta: "*** Begin Patch\n",
			},
			{
				type: "response.custom_tool_call_input.done",
				item_id: "other",
				input: "do-not-convert",
			},
			{
				type: "response.custom_tool_call_input.done",
				output_index: 3,
				item_id: "apply",
			},
			{
				type: "response.output_item.done",
				item: {
					id: "other",
					type: "custom_tool_call",
					name: "other_tool",
					input: "raw",
				},
			},
			{
				type: "response.output_item.done",
				output_index: 3,
				item: { id: "apply", type: "custom_tool_call", name: "apply_patch" },
			},
		];

		const mapped = await collect(mapFreeformEvents(toAsync(events), "apply_patch"));

		expect(mapped[0]).toMatchObject({
			type: "response.output_item.added",
			item: { id: "apply", type: "function_call", arguments: "" },
		});
		expect(mapped[2]).toBe(events[2]);
		expect(mapped[3]).toMatchObject({
			type: "response.function_call_arguments.delta",
			output_index: 3,
			delta: '{"input":"*** Begin Patch\\n',
		});
		expect(mapped[4]).toBe(events[4]);
		expect(mapped[5]).toEqual({
			type: "response.function_call_arguments.delta",
			output_index: 3,
			delta: '"}',
		});
		expect(mapped.at(-2)).toMatchObject({
			type: "response.function_call_arguments.done",
			output_index: 3,
			arguments: JSON.stringify({ input: "*** Begin Patch\n" }),
		});
		expect(mapped.at(-1)).toMatchObject({
			type: "response.output_item.done",
			item: {
				id: "apply",
				type: "function_call",
				arguments: JSON.stringify({ input: "*** Begin Patch\n" }),
			},
		});
	});

	it("converts apply_patch tools to Codex custom grammar tools", () => {
		const tools = convertTools(
			[
				{ name: "read", description: "Read", parameters: { type: "object" } },
				{
					name: "apply_patch",
					description: "JSON wrapper",
					parameters: { type: "object" },
				},
			] as any,
			{
				toolName: "apply_patch",
				description: "Freeform apply_patch",
				grammar: "start: /.+/",
			},
		);

		expect(tools[0]).toMatchObject({ type: "function", name: "read" });
		expect(tools[1]).toEqual({
			type: "custom",
			name: "apply_patch",
			description: "Freeform apply_patch",
			format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
		});
	});

	it("parses CRLF SSE frames and flushes a final frame without a blank line", async () => {
		const encoder = new TextEncoder();
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"type":"first"}\r\n\r\n'));
					controller.enqueue(encoder.encode('data: {"type":"second"}'));
					controller.close();
				},
			}),
		);

		await expect(collect(parseSSE(response))).resolves.toEqual([{ type: "first" }, { type: "second" }]);
	});

	it("sends only response input deltas in websocket-cached mode", async () => {
		const sentBodies: any[] = [];
		const responses = [
			{ responseId: "resp_1", messageId: "msg_1", text: "Hello" },
			{ responseId: "resp_2", messageId: "msg_2", text: "Done" },
		];

		class MockWebSocket {
			static OPEN = 1;
			readyState = MockWebSocket.OPEN;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(data: string): void {
				sentBodies.push(JSON.parse(data));
				const response = responses.shift();
				if (!response) throw new Error("unexpected websocket request");
				const events = [
					{ type: "response.created", response: { id: response.responseId } },
					{
						type: "response.output_item.added",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: response.text },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: response.messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: response.text }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: response.responseId,
							status: "completed",
							usage: {
								input_tokens: 5,
								output_tokens: 3,
								total_tokens: 8,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				queueMicrotask(() => {
					for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
				});
			}

			close(): void {
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		let streamSimple: any;
		registerApplyPatchFreeformProvider(
			{
				registerProvider: (_name: string, provider: any) => {
					streamSimple = provider.streamSimple;
				},
				on: () => {},
				registerMessageRenderer: () => {},
			} as any,
			{ toolName: "apply_patch", description: "Apply patch", grammar: "start: /.+/" },
		);

		const model = {
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			headers: {},
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const apiKey = mockCodexToken();
		const firstContext = {
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const first = await streamSimple(model, firstContext, {
			apiKey,
			sessionId: "session-1",
			transport: "websocket-cached",
		}).result();
		await streamSimple(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [...firstContext.messages, first, { role: "user", content: "Now finish", timestamp: 2 }],
			},
			{ apiKey, sessionId: "session-1", transport: "websocket-cached" },
		).result();

		expect(sentBodies).toHaveLength(2);
		expect(sentBodies[0].previous_response_id).toBeUndefined();
		expect(sentBodies[0].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }]);
		expect(sentBodies[1].previous_response_id).toBe("resp_1");
		expect(sentBodies[1].input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Now finish" }] }]);
		expect(getOpenAICodexWebSocketDebugStats("session-1")).toMatchObject({
			requests: 2,
			connectionsCreated: 1,
			connectionsReused: 1,
			cachedContextRequests: 2,
			fullContextRequests: 1,
			deltaRequests: 1,
			lastDeltaInputItems: 1,
			lastPreviousResponseId: "resp_1",
		});
	});

	it("reports generic websocket failures as retryable connection errors", async () => {
		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(_data: string): void {
				queueMicrotask(() => this.dispatch("error", {}));
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		let streamSimple: any;
		registerApplyPatchFreeformProvider(
			{
				registerProvider: (_name: string, provider: any) => {
					streamSimple = provider.streamSimple;
				},
				on: () => {},
				registerMessageRenderer: () => {},
			} as any,
			{ toolName: "apply_patch", description: "Apply patch", grammar: "start: /.+/" },
		);

		const result = await streamSimple(
			{
				id: "gpt-5.5",
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				headers: {},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{ messages: [{ role: "user", content: "Make a patch", timestamp: 1 }] },
			{ apiKey: mockCodexToken(), sessionId: "session-error", transport: "websocket-cached" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(
			/^WebSocket connection error after \d+s \(\d+s since last event, 0 events\)$/,
		);
	});

	it("falls back to SSE after repeated websocket failures", async () => {
		let websocketConstructs = 0;
		let fetchCalls = 0;
		const originalFetch = globalThis.fetch;

		class MockWebSocket {
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				websocketConstructs++;
				queueMicrotask(() => this.dispatch("open", {}));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(_data: string): void {
				queueMicrotask(() => this.dispatch("error", {}));
			}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		globalThis.fetch = (async () => {
			fetchCalls++;
			const encoder = new TextEncoder();
			const events = [
				{ type: "response.created", response: { id: "resp_sse" } },
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "Recovered" },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_sse",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Recovered" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_sse",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		try {
			let streamSimple: any;
			registerApplyPatchFreeformProvider(
				{
					registerProvider: (_name: string, provider: any) => {
						streamSimple = provider.streamSimple;
					},
					on: () => {},
					registerMessageRenderer: () => {},
				} as any,
				{ toolName: "apply_patch", description: "Apply patch", grammar: "start: /.+/" },
			);

			const model = {
				id: "gpt-5.5",
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
				headers: {},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const context = { messages: [{ role: "user", content: "Make a patch", timestamp: 1 }] };
			const options = { apiKey: mockCodexToken(), sessionId: "session-fallback", transport: "websocket-cached" };

			for (let index = 0; index < 3; index++) {
				const result = await streamSimple(model, context, options).result();
				expect(result.stopReason).toBe("error");
			}
			const recovered = await streamSimple(model, context, options).result();

			expect(recovered.stopReason).toBe("stop");
			expect(websocketConstructs).toBe(3);
			expect(fetchCalls).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}
