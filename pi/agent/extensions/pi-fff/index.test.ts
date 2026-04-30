import { describe, expect, test } from "bun:test";

import fffExtension from "./index";

function createTools() {
  const tools: any[] = [];
  fffExtension({
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    on() {},
  } as any);
  return tools;
}

function createText() {
  let value = "";
  return {
    setText(next: string) {
      value = next;
    },
    getText() {
      return value;
    },
  };
}

const theme = {
  fg(_role: string, text: string) {
    return text;
  },
  bold(text: string) {
    return `**${text}**`;
  },
};

describe("pi-fff rendering", () => {
  test("search tools self-render without the default success shell", () => {
    const tools = createTools();

    expect(tools.find((tool) => tool.name === "grep")?.renderShell).toBe("self");
    expect(tools.find((tool) => tool.name === "find")?.renderShell).toBe("self");
    expect(tools.find((tool) => tool.name === "multi_grep")?.renderShell).toBe("self");
  });

  test("grep calls render as compact exploration", () => {
    const grep = createTools().find((tool) => tool.name === "grep");
    const text = createText();

    grep.renderCall(
      { pattern: "foo", path: "src/" },
      theme,
      { lastComponent: text, toolCallId: "grep-call", isPartial: false },
    );

    expect(text.getText()).toContain("• **Explored**");
    expect(text.getText()).toContain("└ Search foo in src/");
  });

  test("collapsed grep results stay hidden under the exploration block", () => {
    const grep = createTools().find((tool) => tool.name === "grep");
    const text = createText();

    grep.renderResult(
      {
        content: [
          {
            type: "text",
            text: "src/a.ts:12: const foo = 1;",
          },
        ],
        details: { patterns: ["foo"] },
      },
      { expanded: false },
      theme,
      { lastComponent: text, toolCallId: "grep-call" },
    );

    expect(text.getText()).toBe("");
  });

  test("expanded grep results render with a Codex-style gutter and highlighted matches", () => {
    const grep = createTools().find((tool) => tool.name === "grep");
    const text = createText();

    grep.renderResult(
      {
        content: [
          {
            type: "text",
            text: "src/a.ts:12: const foo = 1;\nsrc/a.ts-13- const bar = 2;",
          },
        ],
        details: { patterns: ["foo"] },
      },
      { expanded: true },
      theme,
      { lastComponent: text },
    );

    expect(text.getText()).toContain("  ├ src/a.ts");
    expect(text.getText()).toContain("  │     12 │ const **foo** = 1;");
    expect(text.getText()).toContain("  └     13 │ const bar = 2;");
  });

  test("expanded grep highlighting respects regex search mode", () => {
    const grep = createTools().find((tool) => tool.name === "grep");
    const text = createText();

    grep.renderResult(
      {
        content: [
          {
            type: "text",
            text: "src/a.ts:12: const renderShell = true;",
          },
        ],
        details: { patterns: ["render(Shell|Result)"], matchMode: "regex" },
      },
      { expanded: true },
      theme,
      { lastComponent: text },
    );

    expect(text.getText()).toContain("const **renderShell** = true;");
  });

  test("expanded find results render grouped by directory under the gutter", () => {
    const find = createTools().find((tool) => tool.name === "find");
    const text = createText();

    find.renderResult(
      { content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nREADME.md" }] },
      { expanded: true },
      theme,
      { lastComponent: text },
    );

    expect(text.getText()).toContain("  ├ src/");
    expect(text.getText()).toContain("  │   ├ a.ts");
    expect(text.getText()).toContain("  │   └ b.ts");
    expect(text.getText()).toContain("  │ ./");
    expect(text.getText()).toContain("  └   └ README.md");
  });
});
