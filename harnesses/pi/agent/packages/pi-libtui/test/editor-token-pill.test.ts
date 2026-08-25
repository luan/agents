import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { parseBackgroundAnsi, tuiTheme } from "../src/color/theme.ts";
import { renderEditorPasteMarkerPills, renderEditorTokenPills } from "../src/decoration/editor-pills.ts";

const theme = {
	name: "editor-token-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;220;220;220m",
	getBgAnsi: () => "\x1b[48;2;30;34;42m",
} as never as Theme;

describe("editor token pills", () => {
	test("chooses a pill surface distinct from the editor destination", () => {
		const destination = "\x1b[48;2;30;34;42m";
		const rendered = renderEditorPasteMarkerPills([`${destination}[paste #1 +30 lines]\x1b[49m`], 40, theme).lines[0]!;
		const backgrounds = [...rendered.matchAll(/\x1b\[48;2;\d+;\d+;\d+m/gu)].map((match) => match[0]);
		expect(backgrounds).toContain(destination);
		expect(backgrounds.some((background) => background !== destination)).toBe(true);
		expect(stripTerminalSequences(rendered)).toContain("paste #1 +30 lines");
		expect(parseBackgroundAnsi(backgrounds.find((background) => background !== destination) ?? "")).toBeDefined();
	});

	test("renders a private atomic token without changing the cursor text around it", () => {
		const token = "\ue100";
		const rendered = renderEditorTokenPills([`before \x1b[7m${token}\x1b[0m after`], 40, theme, [
			{ token, label: "Image #1", icon: "view-image", iconTone: { hue: "magenta", shade: 2 } },
		]).lines[0]!;
		const plain = stripTerminalSequences(rendered);
		expect(plain).toContain("before ");
		expect(plain).toContain("Image #1");
		expect(plain).toContain(" after");
		expect(rendered).not.toContain(token);
		expect(rendered).toContain(tuiTheme(theme).fgAnsi({ hue: "magenta", shade: 2 }));
	});

	test("lets a feature renderer preserve inverse and destination state", () => {
		const token = "\ue101";
		const contexts: Array<{ inverse: boolean; destination: string }> = [];
		const destination = "\x1b[48;5;22m";
		const result = renderEditorTokenPills([`${destination}before \x1b[7m${token}\x1b[0m after`], 40, theme, [
			{
				token,
				icon: false,
				label: "Token",
				render: ({ content, destinationBackgroundAnsi, inverse }) => {
					contexts.push({ inverse, destination: destinationBackgroundAnsi });
					return content.label;
				},
			},
		]);
		expect(contexts).toEqual([{ inverse: true, destination }]);
		expect(result.pills).toEqual([{ line: 0, x: 7, width: 5, token }]);
		expect(stripTerminalSequences(result.lines[0]!)).toContain("before Token after");
	});
});
