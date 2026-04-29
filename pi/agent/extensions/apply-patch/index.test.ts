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
		expect(secondText).toContain("function renderSummary");
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
