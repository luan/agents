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
import { ToolControlService } from "../src/runtime/tool-controls.ts";

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
	let height = 32;
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
		height: () => 32,
		close: () => {
			closed = true;
		},
		dialogs,
	});
	return { view, shown: () => shown, hidden: () => hidden, closed: () => closed };
}

describe("report UI", () => {
	test("restores the compact historical frame, bars, table, and report views", () => {
		const { view, text } = screen();
		expect(text()).toContain("500 / 1,000");
		expect(text()).toContain("50.0%");
		expect(text()).toContain("System prompt — estimated");
		expect(text()).toContain("▸ Base prompt");
		const lines = view.render(120);
		expect(stripTerminalSequences(lines[0]!)).toBe(`╭${"─".repeat(32)} Token Burden ${"─".repeat(32)}╮`);
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(lines.length).toBeLessThan(32);
		expect(text()).not.toMatch(/Inspector|Context snapshot|▐Overview▌|Current branch usage|Whole session usage/);
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
		expect(text()).toContain("Active · lookup");
		view.handleInput("\r");
		modal()?.handleInput?.("\x1b");
		expect(closed()).toBe(false);
		view.handleInput("\x18");
		expect(text()).toContain("▸ Tool schemas");
		view.handleInput("\x18");
		expect(closed()).toBe(true);
	});
	test("bounds rendering at narrow widths and terminal heights", () => {
		const { view, resize } = screen();
		for (const width of [0, 1, 2, 8, 30, 80, 120])
			for (const height of [0, 1, 2, 8, 24, 40]) {
				resize(height);
				const lines = view.render(width);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
	});
	test("details scroll to the end of long prompt sections", () => {
		const { report, view, modal } = screen();
		report.promptSections = [
			{ label: "Long", estimate: 100, content: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n") },
		];
		view.handleInput("\x1b[C");
		view.handleInput("\r");
		const detail = modal();
		expect(detail).toBeDefined();
		expect(stripTerminalSequences(detail!.render(40).join("\n"))).toContain("line 0");
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
		expect(stripTerminalSequences(view.render(120).join("\n"))).toContain("Context unavailable");
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
		view.handleInput("e");
		expect(shown()).toBeDefined();
		expect(shown()!.options).toMatchObject({ width: 80 });
		expect(stripTerminalSequences(shown()!.component.render(40).join("\n"))).toContain("Estimate");
		shown()!.component.handleInput?.("\x1b");
		expect(hidden()).toBe(1);
		expect(closed()).toBe(false);
		view.handleInput("\x1b");
		expect(closed()).toBe(true);
	});

	test("keeps token estimates visible beside long labels and ranks the largest first", () => {
		const { report, view } = screen();
		report.promptSections = [
			{ label: "Small section", estimate: 10, content: "small" },
			{ label: "界".repeat(60), estimate: 12345, content: "large" },
		];
		view.handleInput("\x1b[C");
		const lines = stripTerminalSequences(view.render(80).join("\n"));
		expect(lines).toContain("~12,345 tokens");
		expect(lines.indexOf("~12,345 tokens")).toBeLessThan(lines.indexOf("~10 tokens"));
		expect(lines).toContain("Prompt  ← esc to go back");
	});

	test("filters the current table and returns through drilldown without closing", () => {
		const { view, text, closed } = screen();
		view.handleInput("/");
		for (const character of "Tool schemas") view.handleInput(character);
		expect(text()).toContain("▸ Tool schemas");
		expect(text()).not.toContain("▸ Base prompt");
		view.handleInput("\r");
		view.handleInput("\r");
		expect(text()).toContain("Active · lookup");
		view.handleInput("h");
		expect(text()).toContain("▸ Tool schemas");
		expect(closed()).toBe(false);
		view.handleInput("q");
		expect(closed()).toBe(true);
	});

	test("activates a clicked row after the selection redraw", () => {
		const { view, text } = screen();
		const row = view.render(80).findIndex((line) => stripTerminalSequences(line).includes("Tool schemas"));
		const event = {
			row,
			col: 6,
			screenRow: row,
			screenCol: 6,
			button: 0 as const,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		};
		view.onMouse({ ...event, type: "press" });
		view.render(80);
		view.onMouse({ ...event, type: "release" });
		expect(text()).toContain("Tools  ← esc to go back");
		expect(text()).toContain("Active · lookup");
	});

	test("retains command provenance in help without crowding the overview", () => {
		const { view, modal } = screen();
		view.handleInput("?");
		const help = modal()!;
		help.render(80);
		help.handleInput?.("\x1b[F");
		const text = stripTerminalSequences(help.render(80).join("\n"));
		expect(text).toContain("/demo · extension");
		expect(text).toContain("/extensions/example.ts");
	});

	test("limits the table to eight rows and keeps the selected row visible", () => {
		const { report, view, text } = screen();
		report.promptSections = Array.from({ length: 20 }, (_, index) => ({
			label: `Section ${index}`,
			estimate: 100 - index,
			content: "content",
		}));
		view.handleInput("\x1b[C");
		view.render(80);
		expect(
			text()
				.split("\n")
				.filter((line) => /[▸·] Section \d/.test(line)).length,
		).toBeLessThanOrEqual(8);
		view.handleInput("\x1b[F");
		expect(text()).toContain("▸ Context file: /AGENTS.md");
		expect(text()).toContain("21/21");
	});

	test("refreshes tool state and prevents duplicate toggles while waiting for idle", async () => {
		const { pi, ctx } = fixture();
		const report = collectReport(pi, ctx);
		let active = ["lookup"];
		let finishIdle = () => {};
		const idle = new Promise<void>((resolve) => {
			finishIdle = resolve;
		});
		let writes = 0;
		const view = new ReportScreen(report, {
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			requestRender() {},
			height: () => 24,
			close() {},
			dialogs: { open: () => () => {} },
			toolControls: new ToolControlService({
				getAllTools: () => report.tools,
				getActiveTools: () => active,
				setActiveTools: (names) => {
					active = names;
					writes++;
				},
				waitForIdle: () => idle,
			}),
		});
		view.handleInput("\x1b[C");
		view.handleInput("\x1b[C");
		view.render(120);
		view.handleInput(" ");
		view.handleInput(" ");
		expect(stripTerminalSequences(view.render(120).join("\n"))).toContain("lookup: waiting for idle");
		active.push("inactive");
		finishIdle();
		await idle;
		await Promise.resolve();
		const text = stripTerminalSequences(view.render(120).join("\n"));
		expect(writes).toBe(1);
		expect(text).toContain("Inactive · lookup");
		expect(text).toContain("Active · inactive");
		expect(text).toContain("lookup disabled for future turns");
	});
});
