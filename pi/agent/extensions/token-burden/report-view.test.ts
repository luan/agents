import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatToolSectionMarkdown,
	isBackKey,
	isForwardKey,
	isNavigateDownKey,
	isNavigateUpKey,
	showReport,
} from "./report-view";

describe("token burden vim key bindings", () => {
	test("maps vim movement keys to existing overlay actions", () => {
		expect(isNavigateUpKey("k")).toBe(true);
		expect(isNavigateDownKey("j")).toBe(true);
		expect(isForwardKey("l")).toBe(true);
		expect(isBackKey("h")).toBe(true);
		expect(isBackKey("q")).toBe(true);
	});

	test("does not treat unrelated printable keys as navigation", () => {
		expect(isNavigateUpKey("u")).toBe(false);
		expect(isNavigateDownKey("d")).toBe(false);
		expect(isForwardKey("f")).toBe(false);
		expect(isBackKey("b")).toBe(false);
	});
});

describe("token burden tools overlay", () => {
	test("formats active and inactive tool definitions as markdown", () => {
		const content = formatToolSectionMarkdown({
			active: [
				{
					name: "bash",
					chars: 20,
					tokens: 10,
					content: '{"name":"bash","description":"Run a shell command","parameters":{"type":"object"}}',
				},
			],
			inactive: [
				{
					name: "find",
					chars: 20,
					tokens: 10,
					content: '{"name":"find","description":"Find text","parameters":{"type":"object"}}',
				},
			],
		});

		expect(content).toContain("# Tool definitions");
		expect(content).toContain("## Active tools");
		expect(content).toContain("### bash");
		expect(content).toContain("Run a shell command");
		expect(content).toContain("#### Parameters");
		expect(content).toContain('"type": "object"');
		expect(content).toContain("## Inactive tools");
		expect(content).toContain("### find");
	});

	test("opens the whole tool section from the top-level view", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "token-burden-view-"));
		const editorScript = join(tmp, "editor.cjs");
		const openedPathFile = join(tmp, "opened-path");
		const oldEditor = process.env.EDITOR;
		const oldVisual = process.env.VISUAL;

		writeFileSync(
			editorScript,
			[
				"const { writeFileSync } = require('node:fs');",
				`writeFileSync(${JSON.stringify(openedPathFile)}, process.argv.at(-1));`,
			].join("\n"),
			"utf8",
		);

		try {
			delete process.env.VISUAL;
			process.env.EDITOR = `${process.execPath} ${editorScript}`;

			const ctx = {
				ui: {
					custom: async (factory: any) => {
						const component = factory({ requestRender() {}, stop() {}, start() {} }, {}, {}, () => {});
						component.handleInput("e");
					},
				},
			};

			await showReport(
				{
					totalChars: 20,
					totalTokens: 10,
					skills: [],
					sections: [
						{
							label: "Tool definitions (1 active, 2 total)",
							chars: 20,
							tokens: 10,
							tools: {
								active: [
									{
										name: "bash",
										chars: 20,
										tokens: 10,
										content: '{"name":"bash","description":"Run a shell command"}',
									},
								],
								inactive: [
									{
										name: "find",
										chars: 20,
										tokens: 10,
										content: '{"name":"find","description":"Find text"}',
									},
								],
							},
							children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						},
					],
				},
				100,
				ctx as any,
			);

			const openedPath = readFileSync(openedPathFile, "utf8");
			expect(openedPath.endsWith(".md")).toBe(true);
			const openedContent = readFileSync(openedPath, "utf8");
			expect(openedContent).toContain("# Tool definitions");
			expect(openedContent).toContain("### bash");
			expect(openedContent).toContain("Run a shell command");
			expect(openedContent).toContain("### find");
			expect(openedContent).toContain("Find text");
		} finally {
			if (oldEditor === undefined) {
				delete process.env.EDITOR;
			} else {
				process.env.EDITOR = oldEditor;
			}
			if (oldVisual === undefined) {
				delete process.env.VISUAL;
			} else {
				process.env.VISUAL = oldVisual;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("toggles the selected active tool through the supplied handler", async () => {
		const calls: Array<{ toolName: string; enabled: boolean }> = [];
		let renderedAfterToggle = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput(" ");
					renderedAfterToggle = component.render(80).join("\n");
				},
			},
		};

		await showReport(
			{
				totalChars: 20,
				totalTokens: 10,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [{ name: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
							inactive: [{ name: "find", chars: 20, tokens: 10, content: '{"name":"find"}' }],
						},
						children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
			[],
			undefined,
			undefined,
			(toolName, enabled) => {
				calls.push({ toolName, enabled });
				return { applied: true, activeToolNames: [] };
			},
		);

		expect(calls).toEqual([{ toolName: "bash", enabled: false }]);
		expect(renderedAfterToggle).toContain("Active (0)");
		expect(renderedAfterToggle).toContain("Inactive (2");
	});
});
