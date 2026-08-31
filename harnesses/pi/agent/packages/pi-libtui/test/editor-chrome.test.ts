import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "pi-libtui";
import {
	type EditorCompositionStyle,
	renderEditorComposition,
	renderEditorCompositionPreview,
	renderEditorCompositionStatus,
} from "pi-libtui/editor";

const theme = {
	name: "editor-chrome-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;100;140;200m",
	getBgAnsi: () => "\x1b[48;2;24;28;36m",
} as never as Theme;

const style: EditorCompositionStyle = {
	surface: "editor",
	top: "half-block",
	bottom: "none",
	leftRail: "animated",
	rightRail: "static",
	promptMarker: ["▸", "▹"],
	promptMarkerMotion: "always",
	bottomStatus: true,
	statusSeparator: "dot",
	statusBand: "transparent",
	inactiveRailTone: "accent",
};

describe("editor composition chrome", () => {
	test("top rule renders the top quadrants", () => {
		const topRuleStyle = { ...style, top: "rule" } as const;
		const plain = renderEditorComposition(theme, topRuleStyle, {
			width: 48,
			content: ["draft"],
			topStatus: { left: "Working", right: "ctx 4%" },
		}).map(stripTerminalSequences);

		expect(plain[0]).toContain("Working");
		expect(plain[0]).toContain("ctx 4%");
	});
	test("keeps every composed row within the exact terminal width", () => {
		const lines = renderEditorComposition(theme, style, {
			width: 80,
			content: ["draft"],
			topStatus: { right: "~/src/agents · next · GPT-5.6 Sol · xhigh · fast" },
			active: true,
			elapsedMs: 720,
		});

		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("draft");
	});

	test("uses the production renderer for complete candidate previews", () => {
		const lines = renderEditorCompositionPreview(theme, { style }, 72);

		expect(lines.every((line) => visibleWidth(line) === 72)).toBe(true);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("Ask anything, edit files, run tools");
	});

	test("continues the editor surface and rails through its standalone status row", () => {
		const belowStyle = { ...style, bottomStatus: true } as const;
		const lines = renderEditorCompositionStatus(theme, belowStyle, { left: "Working", right: "ctx 4%" }, 48, {
			active: true,
			elapsedMs: 400,
		});

		expect(lines).toHaveLength(1);
		expect(stripTerminalSequences(lines[0] ?? "")).toContain("Working");
		expect(stripTerminalSequences(lines[0] ?? "").trimEnd()).toEndWith("┃");
		expect(visibleWidth(lines[0] ?? "")).toBe(48);
	});

	test("keeps the cap half-height and metadata inline when the prompt row has room", () => {
		const lines = renderEditorComposition(theme, style, {
			width: 48,
			content: ["draft"],
			topStatus: { right: "metadata" },
		});

		expect(visibleWidth(lines[0] ?? "")).toBe(48);
		expect(stripTerminalSequences(lines[0] ?? "")).toStartWith("╻▄");
		expect(stripTerminalSequences(lines[0] ?? "").trimEnd()).toEndWith("▄╻");
		expect(lines[0]).not.toContain(tuiTheme(theme).bgAnsi("surface.editor"));
		expect(stripTerminalSequences(lines[0] ?? "")).not.toContain("metadata");
		expect(stripTerminalSequences(lines[1] ?? "")).toContain("draft");
		expect(stripTerminalSequences(lines[1] ?? "")).toContain("metadata");
	});

	test("lifts metadata and expands the right rail when the prompt row needs the space", () => {
		const lines = renderEditorComposition(theme, style, {
			width: 48,
			content: ["a draft long enough to consume the prompt row"],
			topStatus: { right: "metadata" },
		});

		expect(stripTerminalSequences(lines[0] ?? "")).toContain("metadata");
		expect(stripTerminalSequences(lines[0] ?? "")).toStartWith("╻▄");
		expect(stripTerminalSequences(lines[0] ?? "").trimEnd()).toEndWith("┃");
		expect(lines[0]).toContain(`${tuiTheme(theme).bgAnsi("surface.editor")} `);
		expect(stripTerminalSequences(lines[1] ?? "")).not.toContain("metadata");
	});

	test("advances multi-frame prompt markers on the supplied UI timeline", () => {
		const first = stripTerminalSequences(
			renderEditorComposition(theme, style, { width: 40, content: ["draft"], elapsedMs: 0 })[1] ?? "",
		);
		const second = stripTerminalSequences(
			renderEditorComposition(theme, style, { width: 40, content: ["draft"], elapsedMs: 200 })[1] ?? "",
		);

		expect(first).toStartWith("┃ ▸ ");
		expect(second).toStartWith("┃ ▹ ");
	});
});
