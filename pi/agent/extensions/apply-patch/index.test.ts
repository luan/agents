import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import applyPatchExtension from "./index.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

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
	it("uses preview worker for live line numbers instead of speculative line-numberless diff rows", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-render-"));
		writeFileSync(join(cwd, "sample.js"), [
			"function renderSummary(summary) {",
			"const lines = [",
			"  `total words: ${summary.totalWords}`,",
			"  `unique words: ${summary.uniqueWords}`,",
			"  `most common character: ${summary.mostCommonCharacter?.char ?? \"(none)\"} (${summary.mostCommonCharacter?.count ?? 0} occurrences)`,",
			"  `last word: ${summary.lastWord ?? \"(none)\"}`,",
			"  ];",
			"}",
			"",
		].join("\n"));

		const patchInput = `*** Begin Patch
*** Update File: sample.js
@@
-  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} occurrences)\`,
+  \`most common character: \${summary.mostCommonCharacter?.char ?? "(none)"} (\${summary.mostCommonCharacter?.count ?? 0} hits)\`,
*** End Patch
`;

		const tool = registerApplyPatchTool();
		const state: Record<string, unknown> = {};

		const first = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
		const firstText = renderText(first);
		expect(firstText).toContain("sample.js");
		expect(firstText).not.toContain("occurrences)");
		expect(firstText).not.toContain("hits)");

		await delay(1500);

		const second = tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
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

		tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: true }),
		);
	});

	it("renders semantic hunks as separate semantic editing blocks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-semantic-render-"));
		writeFileSync(join(cwd, "sample.js"), [
			"function alpha() {",
			"  return 1;",
			"}",
			"",
			"function beta() {",
			"  return 2;",
			"}",
			"",
		].join("\n"));

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
		tool.renderCall(
			{ input: patchInput },
			theme,
			renderContext(cwd, state, { argsComplete: false }),
		);
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
			{ kind: "hunk", oldLine: null, newLine: null, content: "@@ -1,7 +1,7 @@", path: "sample.js" },
			{ kind: "context", oldLine: 1, newLine: 1, content: "function alpha() {", path: "sample.js", highlightedContent: "function alpha() {" },
			{ kind: "remove", oldLine: 2, newLine: null, content: "  return 1;", path: "sample.js", highlightedContent: "  return 1;" },
			{ kind: "add", oldLine: null, newLine: 2, content: "  return 10;", path: "sample.js", highlightedContent: "  return 10;" },
			{ kind: "context", oldLine: 3, newLine: 3, content: "}", path: "sample.js", highlightedContent: "}" },
			{ kind: "context", oldLine: 4, newLine: 4, content: "", path: "sample.js", highlightedContent: "" },
			{ kind: "context", oldLine: 5, newLine: 5, content: "function beta() {", path: "sample.js", highlightedContent: "function beta() {" },
			{ kind: "remove", oldLine: 6, newLine: null, content: "  return 2;", path: "sample.js", highlightedContent: "  return 2;" },
			{ kind: "add", oldLine: null, newLine: 6, content: "  return 20;", path: "sample.js", highlightedContent: "  return 20;" },
			{ kind: "context", oldLine: 7, newLine: 7, content: "}", path: "sample.js", highlightedContent: "}" },
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
					previewChanges: [{
						path: "sample.js",
						type: "update",
						additions: 2,
						deletions: 2,
						scopes: [
							{ name: "alpha", kind: "function", start_line: 1, end_line: 3 },
							{ name: "beta", kind: "function", start_line: 5, end_line: 7 },
						],
					}],
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
});

describe("apply_patch Codex tool policy", () => {
	it("blocks edit and write when the selected model is from the Codex provider", () => {
		const handlers = new Map<string, Function>();
		const pi = {
			on: (name: string, handler: Function) => {
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
