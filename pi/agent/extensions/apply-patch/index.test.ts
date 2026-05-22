import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import hljs from "highlight.js";
import { resolveInlineLanguageForPath } from "../shared/path-language";
import {
	closeOpenAICodexWebSocketSessions,
	convertFreeformResponsesMessages,
	convertTools,
	getOpenAICodexWebSocketDebugStats,
	mapFreeformEvents,
	parseSSE,
	registerApplyPatchFreeformProvider,
	resetOpenAICodexWebSocketDebugStats,
} from "./freeform-codex.ts";
import applyPatchExtension, {
	APPLY_PATCH_FREEFORM_TOOL_DESCRIPTION,
	APPLY_PATCH_GRAMMAR,
	APPLY_PATCH_TOOL_DESCRIPTION,
} from "./index.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const originalWebSocket = globalThis.WebSocket;
const SUPPORTED_APPLY_PATCH_CONSTRUCTS = [
	"*** Intent: ",
	"*** Environment ID: ",
	"*** Add File: ",
	"*** Delete File: ",
	"*** Update File: ",
	"*** Move File: ",
	"*** Move to: ",
	"*** Replace All In File: ",
	"*** Expect Replacements: ",
	"*** Update Scope: ",
	"@@ lines ",
	"*** End of File",
] as const;

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
});

describe("apply_patch grammar drift guard", () => {
	it("keeps the freeform grammar aligned with supported parser constructs", () => {
		for (const construct of SUPPORTED_APPLY_PATCH_CONSTRUCTS) {
			expect(APPLY_PATCH_GRAMMAR).toContain(construct);
		}
		expect(APPLY_PATCH_GRAMMAR).toContain("preamble: (intent | environment_id)+");
		expect(APPLY_PATCH_GRAMMAR).toContain("move_spec: /(.+) -> (.+)/");
	});

	it("keeps tool descriptions aligned with advanced repair affordances", () => {
		for (const description of [APPLY_PATCH_TOOL_DESCRIPTION, APPLY_PATCH_FREEFORM_TOOL_DESCRIPTION]) {
			expect(description).toContain("*** Intent:");
			expect(description).toContain("@@ lines A-B");
		}
		expect(APPLY_PATCH_TOOL_DESCRIPTION).toContain("*** Update Scope");
	});
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

const rgbTheme = {
	...theme,
	getFgAnsi: (role: string) => (role === "accent" ? "\x1b[38;2;100;120;200m" : "\x1b[38;2;255;255;255m"),
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

describe("apply_patch renderer", () => {
	it("shows only a preparing status while patch input streams", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-render-"));
		const patchInput = `*** Begin Patch
*** Update File: sample.js
@@
-  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} occurrences)\`,
+  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} hits)\`,
*** End Patch
`;

		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const rendered = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
		const text = renderText(rendered);
		expect(text).toContain("Preparing patch…");
		expect(text).toContain("⠋");
		expect(text).not.toContain("apply_patch");
		expect(text).not.toContain("sample.js");
		expect(text).not.toContain("occurrences)");
		expect(text).not.toContain("hits)");
		if (state.elapsedTimer) clearTimeout(state.elapsedTimer as ReturnType<typeof setTimeout>);

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

		tool.renderCall({ input: patchInput }, theme, renderContext(cwd, state, { argsComplete: true }));
	});

	it("animates the preparing status with a spinner and Working-style trickle", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-render-animation-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const early = tool
			.renderCall({ input: "*** Begin Patch\n" }, rgbTheme, renderContext(cwd, state, { argsComplete: false }))
			.render(120)
			.join("\n");
		if (state.elapsedTimer) {
			clearTimeout(state.elapsedTimer as ReturnType<typeof setTimeout>);
			state.elapsedTimer = undefined;
		}
		state.startedAtMs = Date.now() - 240;
		const later = tool
			.renderCall({ input: "*** Begin Patch\n" }, rgbTheme, renderContext(cwd, state, { argsComplete: false }))
			.render(120)
			.join("\n");
		if (state.elapsedTimer) clearTimeout(state.elapsedTimer as ReturnType<typeof setTimeout>);

		expect(stripAnsi(early)).toContain("Preparing patch…");
		expect(stripAnsi(later)).toContain("Preparing patch…");
		expect(stripAnsi(early)).not.toContain("apply_patch");
		expect(stripAnsi(early)).toContain("⠋");
		expect(stripAnsi(later)).toContain("⠹");
		expect(early).not.toBe(later);
		expect(later).toContain("\x1b[38;2;155;186;255m");
	});

	it("renders final diffs with one edited header per file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-multifile-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const diff = `--- a/alpha.ts
+++ b/alpha.ts
@@ -1,4 +1,4 @@
 export function alpha() {
-  return 1;
+  return 10;
 }
--- a/beta.ts
+++ b/beta.ts
@@ -1,4 +1,4 @@
 export function beta() {
-  return 2;
+  return 20;
 }
`;

		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "M alpha.ts\nM beta.ts" }],
				details: {
					stage: "done",
					filesChanged: 2,
					fileDiffs: [
						{ path: "alpha.ts", operation: "update", added: 1, removed: 1 },
						{ path: "beta.ts", operation: "update", added: 1, removed: 1 },
					],
					diff,
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state),
		);

		const text = renderText(result);
		expect(text.match(/Edited alpha\.ts/g)?.length).toBe(1);
		expect(text.match(/Edited beta\.ts/g)?.length).toBe(1);
		expect(text).toContain("return 10;");
		expect(text).toContain("return 20;");
		expect(text).not.toContain("Diff hidden");
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

	it("caches rendered diff output between identical TUI renders", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-render-cache-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "M sample.js" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [{ path: "sample.js", operation: "update", added: 1, removed: 1 }],
					diff: resolvedDiff,
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);

		const first = rendered.render(120);
		expect(rendered.render(120)).toBe(first);
		rendered.invalidate();
		expect(rendered.render(120)).not.toBe(first);
	});

	it("registers WGSL grammar for inline diff rendering", () => {
		expect(resolveInlineLanguageForPath("crates/majinterm/src/shaders/terminal_background.wgsl")).toBe("wgsl");
		expect(hljs.getLanguage("wgsl")).toBeDefined();

		const highlighted = hljs.highlight("@vertex\nfn vs_main() -> vec4<f32> {\n  return vec4<f32>(1.0);\n}", {
			language: "wgsl",
			ignoreIllegals: true,
		}).value;

		expect(highlighted).toContain('class="hljs-attr">@vertex</span>');
		expect(highlighted).toContain('class="hljs-keyword">fn</span>');
		expect(highlighted).toContain('class="hljs-type">vec4</span>');
	});

	it("renders live WGSL patch previews without falling back to an unknown language", () => {
		initTheme("dark");
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-wgsl-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const patchInput = `*** Begin Patch
*** Add File: shader.wgsl
+@vertex
+fn vs_main() -> vec4<f32> {
+  return vec4<f32>(1.0);
+}
*** End Patch
`;

		const rendered = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
		const text = renderText(rendered);

		expect(text).toContain("Preparing patch…");
		expect(text).not.toContain("@vertex");
		expect(text).not.toContain("fn vs_main() -> vec4<f32>");
	});

	it("renders final WGSL diff rows with inline syntax highlighting", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-wgsl-final-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const diff = `--- a/shader.wgsl
+++ b/shader.wgsl
@@ -0,0 +1,2 @@
+fn vs_main() -> vec4<f32> {
+  return vec4<f32>(1.0);
`;

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "A shader.wgsl" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [{ path: "shader.wgsl", operation: "add", added: 2, removed: 0 }],
					diff,
					highlightedDiffRows: [
						{ kind: "hunk", oldLine: null, newLine: null, content: "@@ -0,0 +1,2 @@", path: "shader.wgsl" },
						{
							kind: "add",
							oldLine: null,
							newLine: 1,
							content: "fn vs_main() -> vec4<f32> {",
							path: "shader.wgsl",
						},
						{ kind: "add", oldLine: null, newLine: 2, content: "  return vec4<f32>(1.0);", path: "shader.wgsl" },
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const raw = rendered.render(140).join("\n");
		const text = stripAnsi(raw);

		expect(text).toContain("fn vs_main() -> vec4<f32>");
		expect(raw).toMatch(/\x1b\[[0-9;]*mfn\x1b\[[0-9;]*m vs_main/);
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
		expect(renderText(initial)).toContain("Preparing patch…");

		const finalizing = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false, isPartial: false }),
		);

		expect(renderText(finalizing)).toBe("");
	});

	it("renders semantic hunks under one edited header per file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-semantic-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
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
		expect(finalText.match(/Edited sample\.js/g)?.length).toBe(1);
		expect(finalText).toContain("function alpha:1-3");
		expect(finalText).toContain("function beta:5-7");
	});

	it("wraps long apply failure text inside the rendered width", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-error-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const longError = [
			"Error: ambiguous context in pi/agent/extensions/widget/index.ts at chunk #0 — matched 6 location(s) at lines [268, 297, 312, 335, 344, 351]; widen the context or use a more specific @@ anchor",
			"suggested anchors:",
			"  @@ function eventFor(ctx: any, event: WidgetHookEventName, extra: Record<string, unknown> = {}) {  →  pins to candidate at line 268 (anchor at line 240)",
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

	it("keeps failed patch diagnostics concise", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-error-concise-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const verboseError = [
			'Error: context not found in sample.ts at chunk #1: first expected line was "function target() {"',
			"file state (closest match: line 40 at edit distance 2):",
			...Array.from({ length: 18 }, (_, index) => `${30 + index}: const filler${index} = ${index};`),
			"suggested anchors:",
			"  @@ lines 40-44  → pins to candidate at line 40",
		].join("\n");

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: verboseError }],
				details: { stage: "apply" },
			},
			{ expanded: false, isPartial: false },
			theme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const text = renderText(rendered, 100);

		expect(text).toContain("Error: context not found");
		expect(text).toContain("file state (closest match");
		expect(text).toContain("@@ lines 40-44");
		expect(text).toContain("diagnostic lines omitted");
		expect(text).not.toContain("filler17");
		expect(text.split("\n").length).toBeLessThanOrEqual(16);
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

	it("renders failed context diagnostics on a coherent error panel", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-error-context-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const toolErrorBg = "\u001b[48;2;80;0;0m";
		const errorFg = "\u001b[31m";
		const bgTheme = {
			...theme,
			fg: (color: string, text: string) => (color === "error" ? `${errorFg}${text}\u001b[0m` : text),
			getBgAnsi: (color: string) => (color === "toolErrorBg" ? toolErrorBg : undefined),
		};
		const contextError = [
			'Error: context not found in /repo/footer.ts at chunk #3: first expected line was "function wrapFooterSegments(segments: string[], width: number, sep: string): string[] {"',
			"file state (closest match: line 71 at edit distance 0):",
			"63: function fitFooterSegment(width: number, variants: string[]): string {",
			"64: \tconst safeWidth = Math.max(1, width);",
			"",
			"65: \tfor (const variant of variants) {",
			"",
			"66: \t\tif (visibleWidth(variant) <= safeWidth) return variant;",
		].join("\n");

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: contextError }],
				details: { stage: "apply" },
			},
			{ expanded: false, isPartial: false },
			bgTheme,
			renderContext(cwd, state, { executionStarted: true }),
		);
		const rawLines = rendered.render(120);
		const sourceLine = rawLines.find((line) => stripAnsi(line).includes("64:   const safeWidth"));

		expect(rawLines.every((line) => line.includes(toolErrorBg))).toBe(true);
		expect(rawLines.join("\n")).toContain(`${errorFg}Error: context not found`);
		expect(sourceLine).toBeDefined();
		expect(sourceLine).not.toContain(errorFg);
		expect(rawLines.join("\n")).not.toContain("\t");
		expect(stripAnsi(rawLines.join("\n"))).toContain("64:   const safeWidth = Math.max(1, width);");
		const fileStateIndex = rawLines.findIndex((line) => stripAnsi(line).includes("file state"));
		expect(rawLines.slice(fileStateIndex + 1).every((line) => stripAnsi(line).trim().length > 0)).toBe(true);
	});

	it("strips OSC hyperlinks before final width clamping", () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-osc-width-render-"));
		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};
		const linkTheme = {
			...theme,
			fg: (_color: string, text: string) => `\x1b]8;;file:///tmp/${text}\x07${text}\x1b]8;;\x07`,
		};
		const diff = `--- a/src/agents.wt1/pi/agent/extensions/token-burden/tool-toggles.ts
+++ b/src/agents.wt1/pi/agent/extensions/token-burden/tool-toggles.ts
@@ -1,3 +1,3 @@
-const oldValue = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
+const newValue = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
`;

		const rendered = tool.renderResult(
			{
				content: [{ type: "text", text: "M token-burden/tool-toggles.ts" }],
				details: {
					stage: "done",
					filesChanged: 1,
					fileDiffs: [
						{
							path: "src/agents.wt1/pi/agent/extensions/token-burden/tool-toggles.ts",
							operation: "update",
							added: 1,
							removed: 1,
						},
					],
					diff,
				},
			},
			{ expanded: false, isPartial: false },
			linkTheme,
			renderContext(cwd, state, { executionStarted: true }),
		);

		const lines = rendered.render(72);
		expect(lines.every((line) => !line.includes("\x1b]8;;"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
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
	it("replays legacy apply_patch calls as Codex custom tool calls with ctc ids", () => {
		const messages = convertFreeformResponsesMessages(
			{
				id: "gpt-5.5",
				provider: "openai-codex",
				api: "openai-codex-responses",
				input: ["text"],
			} as any,
			{
				messages: [
					{
						role: "assistant",
						api: "openai-codex-responses",
						provider: "openai-codex",
						model: "gpt-5.5",
						content: [
							{
								type: "toolCall",
								id: "call_apply_patch|ctc_0ae3fabeb0423f2e016a00c39c449c81919eab6c5ebf693f2e",
								name: "apply_patch",
								arguments: { input: "*** Begin Patch\n*** End Patch" },
							},
						],
						stopReason: "toolUse",
						timestamp: 1,
					},
				],
				systemPrompt: "",
				tools: [],
			} as any,
			"apply_patch",
		) as any[];

		const call = messages.find((item) => item.type === "custom_tool_call");
		expect(call.id.startsWith("ctc_")).toBe(true);
		expect(call.id.startsWith("fc_")).toBe(false);
		expect(call.call_id).toBe("call_apply_patch");
	});

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

	it("reports SSE HTTP failures with status when the response body is empty", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;

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
				{ apiKey: mockCodexToken(), sessionId: "session-sse-error", transport: "sse" },
			).result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe(
				"Codex SSE request failed: HTTP 500 Internal Server Error: empty response body",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("sends only response input deltas in websocket-cached mode", async () => {
		const sentBodies: any[] = [];
		let closeCalls = 0;
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
				closeCalls++;
				this.readyState = 3;
			}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		let streamSimple: any;
		const handlers = new Map<string, (() => void)[]>();
		registerApplyPatchFreeformProvider(
			{
				registerProvider: (_name: string, provider: any) => {
					streamSimple = provider.streamSimple;
				},
				on: (event: string, handler: () => void) => {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
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

		for (const handler of handlers.get("session_shutdown") ?? []) handler();
		expect(closeCalls).toBeGreaterThan(0);
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
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({ type: "response.created", response: { id: "resp_error" } }),
					});
					queueMicrotask(() => this.dispatch("error", {}));
				});
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
			/^WebSocket connection error after \d+s \(\d+s since last event, 1 events\)$/,
		);
	});

	it("falls back to SSE after a websocket streaming failure", async () => {
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
				queueMicrotask(() => {
					this.dispatch("message", {
						data: JSON.stringify({ type: "response.created", response: { id: "resp_error" } }),
					});
					queueMicrotask(() => this.dispatch("error", {}));
				});
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

			const failed = await streamSimple(model, context, options).result();
			expect(failed.stopReason).toBe("error");
			const recovered = await streamSimple(model, context, options).result();

			expect(recovered.stopReason).toBe("stop");
			expect(websocketConstructs).toBe(1);
			expect(fetchCalls).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("falls back to SSE with diagnostics when websocket setup closes before response events", async () => {
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
				queueMicrotask(() => this.dispatch("close", { code: 1009, wasClean: false }));
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
				{ apiKey: mockCodexToken(), sessionId: "session-setup-fallback", transport: "websocket-cached" },
			).result();

			expect(result.stopReason).toBe("stop");
			expect(result.content[0].text).toBe("Recovered");
			expect(websocketConstructs).toBe(1);
			expect(fetchCalls).toBe(1);
			expect(result.diagnostics?.[0]).toMatchObject({
				type: "provider_transport_failure",
				details: {
					configuredTransport: "websocket-cached",
					fallbackTransport: "sse",
					eventsEmitted: false,
					phase: "before_message_stream_start",
				},
			});
			expect(getOpenAICodexWebSocketDebugStats("session-setup-fallback")).toMatchObject({
				websocketFailures: 1,
				sseFallbacks: 1,
				websocketFallbackActive: true,
			});
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
