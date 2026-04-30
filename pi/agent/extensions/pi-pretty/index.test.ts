import { describe, expect, test } from "bun:test";

import piPrettyExtension from "./index";

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

class TestText {
	private text: string;
	constructor(text = "") {
		this.text = text;
	}
	setText(next: string) {
		this.text = next;
	}
	getText() {
		return this.text;
	}
}

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

function createTools() {
	const tools: any[] = [];
	piPrettyExtension(
		{
			registerTool(tool: any) {
				tools.push(tool);
			},
			on() {},
		},
		{
			sdk: {
				createReadTool: () => ({
					name: "read",
					async execute() {
						return { content: [{ type: "text", text: "file contents" }] };
					},
				}),
			},
			TextComponent: TestText,
		} as any,
	);
	return tools;
}

describe("pi-pretty read rendering", () => {
	test("read calls render as compact exploration with a capitalized title", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderCall(
			{ path: "/tmp/example.ts" },
			theme,
			{ lastComponent: text, isPartial: false, isError: false, invalidate() {} },
		);

		expect(text.getText()).toContain("• **Explored**");
		expect(text.getText()).toContain("└ Read example.ts");
	});

	test("read results stay collapsed even when expanded", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderResult(
			{ content: [{ type: "text", text: "file contents" }] },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: text, isError: false, invalidate() {} },
		);

		expect(text.getText()).toBe("");
	});
});
