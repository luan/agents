import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import applyPatchExtension from "./index.ts";
import { convertTools, mapFreeformEvents, parseSSE } from "./freeform-codex.ts";

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

function renderText(
  component: { render(width: number): string[] },
  width = 140,
): string {
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

function renderContext(
  cwd: string,
  state: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
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
        "  `total words: ${summary.totalWords}`,",
        "  `unique words: ${summary.uniqueWords}`,",
        '  `most common character: ${summary.mostCommonCharacter?.char ?? "(none)"} (${summary.mostCommonCharacter?.count ?? 0} occurrences)`,',
        '  `last word: ${summary.lastWord ?? "(none)"}`,',
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

    const first = tool.renderCall(
      { input: patchInput },
      theme,
      renderContext(cwd, state, { argsComplete: false }),
    );
    const firstText = renderText(first);
    expect(firstText).toContain("sample.js");
    expect(firstText).toContain("occurrences)");
    expect(firstText).toContain("hits)");
    expect(firstText).not.toContain("5 -");
    expect(firstText).not.toContain("5 +");

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
          fileDiffs: [
            { path: "sample.js", operation: "update", added: 1, removed: 1 },
          ],
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
    writeFileSync(
      join(cwd, "sample.js"),
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function beta() {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
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
          fileDiffs: [
            { path: "sample.js", operation: "update", added: 2, removed: 2 },
          ],
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

    const mapped = await collect(
      mapFreeformEvents(toAsync(events), "apply_patch"),
    );

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

    await expect(collect(parseSSE(response))).resolves.toEqual([
      { type: "first" },
      { type: "second" },
    ]);
  });
});

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
