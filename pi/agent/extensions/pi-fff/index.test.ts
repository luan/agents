import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import fffExtension from "./index";

function createHarness() {
	const tools: any[] = [];
	const handlers: Record<string, any> = {};
	fffExtension({
		registerTool(tool: any) {
			tools.push(tool);
		},
		registerCommand() {},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		on(name: string, handler: any) {
			handlers[name] = handler;
		},
	} as any);
	return { tools, handlers };
}

function createTools() {
	const { tools } = createHarness();
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

		grep.renderCall({ pattern: "foo", path: "src/" }, theme, {
			lastComponent: text,
			toolCallId: "grep-call",
			isPartial: false,
		});

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

	test("tool execution loads FFF native libraries from the staged runtime cache", async () => {
		const previousRuntimeDir = process.env.PI_FFF_RUNTIME_DIR;
		const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-fff-"));
		const cwd = path.join(tmp, "repo");
		const runtimeDir = path.join(tmp, "runtime");
		mkdirSync(cwd);
		writeFileSync(path.join(cwd, "alpha.txt"), "needle\n");
		process.env.PI_FFF_RUNTIME_DIR = runtimeDir;

		const { handlers, tools } = createHarness();
		try {
			await handlers.session_start({}, { cwd, ui: { notify() {}, setEditorComponent() {} } });

			const grep = tools.find((tool) => tool.name === "grep");
			const result = await grep.execute(
				"grep-test",
				{ pattern: "needle", path: "*.txt" },
				new AbortController().signal,
			);

			expect(result.content[0].text).toContain("alpha.txt");
			expect(result.content[0].text).toContain("needle");
			expect(existsSync(runtimeDir)).toBe(true);
			expect(
				readdirSync(runtimeDir, { recursive: true }).some((entry) => String(entry).endsWith("libfff_c.dylib")),
			).toBe(true);
		} finally {
			await handlers.session_shutdown?.();
			if (previousRuntimeDir === undefined) {
				delete process.env.PI_FFF_RUNTIME_DIR;
			} else {
				process.env.PI_FFF_RUNTIME_DIR = previousRuntimeDir;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
