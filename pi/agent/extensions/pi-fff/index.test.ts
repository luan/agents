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

  test("grep results render with a Codex-style gutter and highlighted matches", () => {
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
      { expanded: false },
      theme,
      { lastComponent: text },
    );

    expect(text.getText()).toContain("  ├ src/a.ts");
    expect(text.getText()).toContain("  │     12 │ const **foo** = 1;");
    expect(text.getText()).toContain("  └     13 │ const bar = 2;");
  });

  test("grep highlighting respects regex search mode", () => {
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
      { expanded: false },
      theme,
      { lastComponent: text },
    );

    expect(text.getText()).toContain("const **renderShell** = true;");
  });

  test("find results render grouped by directory under the gutter", () => {
    const find = createTools().find((tool) => tool.name === "find");
    const text = createText();

    find.renderResult(
      { content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\nREADME.md" }] },
      { expanded: false },
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
