import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	TUI_KEYBINDINGS,
	stripTerminalSequences,
	visibleWidth,
	type Component,
	type OverlayOptions,
} from "@earendil-works/pi-tui";
import type { DialogHost } from "@luan.sh/pi-libtui";
import { collectReport } from "../src/runtime/collect-report.ts";
import { ReportScreen } from "../src/ui/report-screen.ts";
import { reportRows } from "../src/ui/report-rows.ts";
import { fixture } from "./fixtures.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
} as Theme;
function screen() {
	const { pi, ctx } = fixture();
	const report = collectReport(pi, ctx);
	let closed = false;
	let modal: Component | undefined;
	const dialogs: DialogHost = {
		open(component) {
			modal = component;
			return () => {
				modal = undefined;
			};
		},
	};
	let height = 20;
	const view = new ReportScreen(report, {
		theme,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x", "tui.select.down": "j" }),
		requestRender() {},
		height: () => height,
		close: () => {
			closed = true;
		},
		dialogs,
	});
	return {
		report,
		view,
		closed: () => closed,
		resize: (rows: number) => {
			height = rows;
		},
		text: () => stripTerminalSequences(view.render(120).join("\n")),
		modal: () => modal,
	};
}

function dialogScreen() {
	let shown: { component: Component; options?: OverlayOptions } | undefined;
	let hidden = 0;
	const { pi, ctx } = fixture();
	const report = collectReport(pi, ctx);
	const dialogs: DialogHost = {
		open(component, options) {
			shown = { component, options: options as OverlayOptions };
			return () => {
				hidden++;
			};
		},
	};
	let closed = false;
	const view = new ReportScreen(report, {
		theme,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender() {},
		height: () => 20,
		close: () => {
			closed = true;
		},
		dialogs,
	});
	return { view, shown: () => shown, hidden: () => hidden, closed: () => closed };
}

describe("report UI", () => {
	test("renders measured context and useful tab content", () => {
		const { view, text } = screen();
		expect(text()).toContain("500 / 1000");
		expect(text()).toContain("50%");
		view.handleInput("\x1b[C");
		expect(text()).toContain("Context file: /AGENTS.md");
		view.handleInput("\x1b[C");
		expect(text()).toContain("Active · lookup");
		expect(text()).toContain("Inactive");
		view.handleInput("\x1b[C");
		expect(text()).toContain("nested tool");
		view.handleInput("\x1b[C");
		expect(text()).toContain("explicit invocation only");
	});
	test("uses injected remapped navigation and cancellation, preserving selection on back", () => {
		const { view, text, closed, modal } = screen();
		view.handleInput("j");
		view.handleInput("\r");
		expect(text()).toContain("Current branch usage");
		modal()?.handleInput?.("\x1b");
		expect(closed()).toBe(false);
		view.handleInput("\x18");
		expect(text()).toContain("> Current branch usage");
		view.handleInput("\x18");
		expect(closed()).toBe(true);
	});
	test("bounds rendering at narrow widths and terminal heights", () => {
		const { view, resize } = screen();
		for (const width of [1, 8, 30, 120])
			for (const height of [1, 8, 24]) {
				resize(height);
				const lines = view.render(width);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
	});
	test("details scroll to the end of long prompt sections", () => {
		const { report, view, text, modal } = screen();
		report.promptSections = [
			{ label: "Long", estimate: 100, content: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n") },
		];
		view.handleInput("\x1b[C");
		view.handleInput("\r");
		expect(text()).toContain("line 0");
		const detail = modal();
		expect(detail).toBeDefined();
		detail?.render(40);
		detail?.handleInput?.("\x1b[F");
		expect(stripTerminalSequences(detail?.render(120).join("\n") ?? "")).toContain("line 99");
	});
	test("empty/unavailable states are visible and skill/tool details explain limits", () => {
		const { report } = screen();
		expect(reportRows(report, "Tools")[0]?.detail).toContain("not actual billing");
		expect(reportRows(report, "Skills")[0]?.detail).toContain("does not load or execute");
		report.context = null;
		report.skills = [];
		const view = new ReportScreen(report, {
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			requestRender() {},
			height: () => 24,
			close() {},
			dialogs: { open: () => () => {} },
		});
		expect(stripTerminalSequences(view.render(120).join("\n"))).toContain("context unavailable");
		view.handleInput("\x1b[D");
		expect(stripTerminalSequences(view.render(120).join("\n"))).toContain("No skills reported");
	});
	test("clips hostile labels and detail text without leaking terminal controls", () => {
		const { report, view, modal } = screen();
		report.promptSections = [
			{
				label: "hostile\nlabel\u001b[31m",
				estimate: 12,
				content: `first\u001b[2J\n${"x".repeat(200)}`,
			},
		];

		// Prompt is the first tab after Overview.
		view.handleInput("\x1b[C");
		view.handleInput("\r");
		const dialog = modal();
		expect(dialog).toBeDefined();
		const lines = dialog!.render(7);
		expect(lines.every((line) => visibleWidth(line) <= 7)).toBe(true);
		const plain = stripTerminalSequences(lines.join("\n"));
		expect(lines.join("\n")).not.toContain("\u001b[2J");
		expect(plain).not.toContain("\u001b");
		expect(plain).toContain("first");
	});
	test("keeps a detail modal bounded at the smallest terminal geometry", () => {
		const { view, resize } = screen();
		view.handleInput("\r");
		resize(1);
		const lines = view.render(1);
		expect(lines.length).toBeLessThanOrEqual(1);
		expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
	});
	test("opens detail in the public overlay host and cancel disposes only the dialog", () => {
		const { view, shown, hidden, closed } = dialogScreen();
		view.handleInput("\r");
		expect(shown()).toBeDefined();
		expect(shown()!.options).toMatchObject({ width: "80%" });
		expect(stripTerminalSequences(shown()!.component.render(40).join("\n"))).toContain("Estimate");
		shown()!.component.handleInput?.("\x1b");
		expect(hidden()).toBe(1);
		expect(closed()).toBe(false);
		view.handleInput("\x1b");
		expect(closed()).toBe(true);
	});
});
