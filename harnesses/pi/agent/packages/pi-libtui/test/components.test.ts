import { afterEach, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	ActionPanel,
	backgroundAnsiAtColumn,
	configureTuiAppearance,
	contrastingPillBackground,
	DEFAULT_TUI_APPEARANCE,
	DialogButtonBar,
	DialogOverlay,
	DialogOverlayHost,
	FramedEditorOverlay,
	FullscreenOverlay,
	MultiSelect,
	offsetDialogHost,
	PickerPanel,
	placeAnchoredOverlay,
	placeTransientPill,
	renderPill,
	SearchableSelect,
	TabBar,
	TransientPill,
	tuiTheme,
} from "../src/index.ts";

describe("shared TUI components", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
		underline: (text: string) => text,
	} as Theme;
	const ansiTheme = {
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		fg: (color: string, text: string) => {
			const code = { accent: 32, border: 34, dim: 90, text: 37, error: 31, muted: 90, success: 32 }[color] ?? 37;
			return `\x1b[${code}m${text}\x1b[39m`;
		},
		bg: (color: string, text: string) => {
			const code = { selectedBg: 45, toolErrorBg: 41, toolPendingBg: 100, toolSuccessBg: 42 }[color] ?? 40;
			return `\x1b[${code}m${text}\x1b[49m`;
		},
		getFgAnsi: (color: string) => {
			const code = { error: 31, muted: 90, success: 32 }[color] ?? 37;
			return `\x1b[${code}m`;
		},
		getBgAnsi: (color: string) => {
			const code = { selectedBg: 45, toolErrorBg: 41, toolPendingBg: 100, toolSuccessBg: 42 }[color] ?? 40;
			return `\x1b[${code}m`;
		},
		underline: (text: string) => text,
	} as Theme;

	function initializeTui(): void {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	}

	test("tabs use h/l and arrows and reset inactive backgrounds on both sides", () => {
		const selected: string[] = [];
		const tabs = new TabBar(
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
			theme,
		);
		tabs.onChange = (tab) => selected.push(tab.id);

		tabs.handleInput("l");
		expect(selected).toEqual(["b"]);
		const rendered = tabs.render(80)[0]!;
		expect(rendered.match(/\x1b\[49m/g)?.length).toBeGreaterThanOrEqual(3);
		tabs.handleInput("h");
		tabs.handleInput("\x1b[D");
		tabs.handleInput("\x1b[C");
		expect(selected).toEqual(["b", "a", "c", "a"]);
	});

	test("tabs resolve semantic icons from the active icon pack on every render", () => {
		const tabs = new TabBar([{ id: "appearance", label: "Appearance", icon: "appearance" }], theme);
		configureTuiAppearance({ iconPack: "unicode" });
		expect(stripTerminalSequences(tabs.render(80)[0]!)).toContain("✦ Appearance");
		configureTuiAppearance({ iconPack: "emoji" });
		expect(stripTerminalSequences(tabs.render(80)[0]!)).toContain("🎨 Appearance");
	});

	test("fullscreen overlay draws a border without applying a panel background", () => {
		const child = { focused: false, render: () => ["content"], invalidate() {} };
		const overlay = new FullscreenOverlay({ terminal: { rows: 4 } } as never, theme, child, "Settings");
		overlay.focused = true;
		const rendered = overlay.render(30).join("\n");

		const plain = stripTerminalSequences(rendered);
		expect(plain).toContain("╭─ Settings");
		expect(plain).toContain("│content");
		expect(plain).toContain("╰");
		expect(rendered).not.toContain("<bg:");
		expect(child.focused).toBe(true);
	});

	test("fullscreen overlay renders in the same turn as forwarded input", () => {
		const inputs: string[] = [];
		let renders = 0;
		const overlay = new FullscreenOverlay(
			{
				terminal: { rows: 4 },
				requestRender: () => renders++,
			} as never,
			theme,
			{
				render: () => ["content"],
				invalidate() {},
				handleInput: (data) => {
					inputs.push(data);
				},
			},
			"Settings",
		);

		overlay.handleInput("j");

		expect(inputs).toEqual(["j"]);
		expect(renders).toBe(1);
	});

	test("fullscreen overlay refreshes and resolves dynamic semantic titles", () => {
		let renders = 0;
		let disposals = 0;
		let title = "Before";
		const tui = {
			terminal: { rows: 4 },
			requestRender: () => {
				renders += 1;
			},
		};
		const overlay = new FullscreenOverlay(
			tui as never,
			theme,
			{ render: () => ["content"], invalidate() {}, dispose: () => disposals++ },
			() => ({
				label: title,
				icon: "settings",
			}),
		);
		expect(stripTerminalSequences(overlay.render(30)[0]!)).toContain("⚙ Before");
		configureTuiAppearance({ iconPack: "emoji" });
		expect(renders).toBe(1);
		title = "After";
		expect(stripTerminalSequences(overlay.render(30)[0]!)).toContain("⚙️ After");
		overlay.dispose();
		overlay.dispose();
		expect(disposals).toBe(1);
		configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
		expect(renders).toBe(1);
	});

	test("dialog host uses Pi's native overlay stack and closes idempotently", () => {
		let shown:
			| {
					component: import("@earendil-works/pi-tui").Component;
					options?: import("@earendil-works/pi-tui").OverlayOptions;
			  }
			| undefined;
		let hidden = 0;
		let renders = 0;
		const tui = {
			terminal: { columns: 100, rows: 30 },
			showOverlay(
				component: import("@earendil-works/pi-tui").Component,
				options?: import("@earendil-works/pi-tui").OverlayOptions,
			) {
				shown = { component, options };
				return {
					hide: () => {
						hidden += 1;
					},
				};
			},
			requestRender: () => {
				renders += 1;
			},
		};
		const host = new DialogOverlayHost(tui as never, theme);
		let childHeight = 0;
		const heightAwareChild = {
			render: () => ["choice"],
			invalidate() {},
			setMaxHeight: (height: number) => {
				childHeight = height;
			},
		};
		const closeHeight = host.open(heightAwareChild, { title: "Height", width: 30, maxHeight: 18 });
		expect(childHeight).toBe(16);
		closeHeight();
		const close = host.open({ render: () => ["choice"], invalidate() {} }, { title: "Mode", width: "60%" });

		expect(shown?.component).toBeInstanceOf(DialogOverlay);
		expect(shown?.options).toMatchObject({ anchor: "center", width: "60%", maxHeight: "90%", margin: 1 });
		expect(stripTerminalSequences(shown!.component.render(30).join("\n"))).toContain("│choice");
		expect(stripTerminalSequences(shown!.component.render(30)[0]!)).toContain("Mode");
		close();
		close();
		expect(hidden).toBe(2);
		expect(renders).toBe(4);

		const scoped = offsetDialogHost(host, { row: 2, col: 3 });
		const closeAnchored = scoped.open(
			{ render: () => ["anchored"], invalidate() {} },
			{
				width: 30,
				parent: { row: 8, col: 20 },
			},
		);
		expect(shown?.options).toMatchObject({ anchor: "top-left", row: 11, col: 24, width: 30, maxHeight: 3, margin: 0 });
		closeAnchored();
	});

	test("searchable select navigates immediately and filters only after slash", () => {
		initializeTui();
		const selected: string[] = [];
		const select = new SearchableSelect({
			title: "Mode",
			options: [
				{ value: "default", label: "Default" },
				{ value: "minimal", label: "Minimal" },
			],
			selected: "default",
			theme,
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});

		select.handleInput("j");
		select.handleInput("\r");
		expect(selected).toEqual(["minimal"]);
		const filtered = new SearchableSelect({
			title: "Mode",
			options: [
				{ value: "default", label: "Default" },
				{ value: "minimal", label: "Minimal" },
			],
			theme,
			onSelect() {},
			onCancel() {},
		});
		filtered.handleInput("/");
		for (const character of "min") filtered.handleInput(character);
		expect(stripTerminalSequences(filtered.render(60).join("\n"))).toContain("Minimal");
		expect(stripTerminalSequences(filtered.render(60).join("\n"))).not.toContain("Default");
	});

	test("searchable select preserves its dialog border and shows a scrollbar when height-bound", () => {
		initializeTui();
		const select = new SearchableSelect({
			title: "Activity marker",
			showTitle: false,
			description: "Compact marker shown beside active work.",
			options: Array.from({ length: 15 }, (_, index) => ({
				value: String(index),
				label: `Option ${index}`,
			})),
			theme,
			onSelect() {},
			onCancel() {},
		});
		const dialog = new DialogOverlay(theme, select, "Activity marker");
		dialog.setMaxHeight(10);

		const rendered = dialog.render(32);
		const plain = rendered.map(stripTerminalSequences);

		expect(rendered).toHaveLength(10);
		expect(plain.at(-1)).toStartWith("╰");
		expect(plain.some((line) => line.includes(" █"))).toBe(true);
	});

	test("picker panel renders rich rows and keeps filtering distinct from navigation", () => {
		initializeTui();
		const selected: string[] = [];
		let cancelled = 0;
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		const pickerTheme = {
			...theme,
			bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		} as Theme;
		const picker = new PickerPanel({
			tui: { terminal: { rows: 20 }, requestRender() {} },
			theme: pickerTheme,
			keybindings,
			title: "Choose",
			options: [
				{ value: "a", label: "Alpha", searchText: "alpha first" },
				{ value: "b", label: "Beta", searchText: "beta second" },
				{ value: "c", label: "Gamma", searchText: "gamma third" },
			],
			selected: "b",
			maxVisible: 2,
			renderOption: (option, context) => `${option.label} at ${context.width}`,
			onSelect: (value) => selected.push(value),
			onCancel: () => {
				cancelled += 1;
			},
		});

		const initial = picker.render(48);
		expect(stripTerminalSequences(initial.join("\n"))).toContain("Choose 2/3");
		expect(
			initial.some((line) => line.includes(tuiTheme(pickerTheme).bgAnsi("surface.selected")) && line.includes("Beta")),
		).toBe(true);
		expect(initial.every((line) => stripTerminalSequences(line).length <= 48)).toBe(true);
		picker.handleInput("j");
		picker.handleInput("\r");
		expect(selected).toEqual(["c"]);

		picker.handleInput("/");
		picker.focused = true;
		for (const character of "alpha") picker.handleInput(character);
		const filtered = picker.render(48).join("\n");
		expect(filtered).toContain(CURSOR_MARKER);
		expect(stripTerminalSequences(filtered)).toContain("Alpha");
		expect(stripTerminalSequences(filtered)).not.toContain("Gamma");
		picker.handleInput("\x1b");
		expect(picker.render(48).join("\n")).not.toContain(CURSOR_MARKER);
		expect(cancelled).toBe(0);
		picker.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	test("action panel supports keyboard, numbered activation, bounded geometry, and cancel", () => {
		initializeTui();
		const selected: string[] = [];
		let renders = 0;
		let cancelled = 0;
		const boundedTheme = { ...theme, bg: (_color: string, text: string) => text } as Theme;
		const panel = new ActionPanel({
			theme: boundedTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "React",
			options: [
				{ value: "good", label: "👍 Looks good" },
				{ value: "no", label: "🚫 Rejected" },
				{ value: "yes", label: "✅ Approved" },
			],
			numberShortcuts: true,
			maxWidth: 32,
			maxHeight: 5,
			requestRender: () => {
				renders += 1;
			},
			onSelect: (value) => selected.push(value),
			onCancel: () => {
				cancelled += 1;
			},
		});

		const lines = panel.render(80);
		expect(lines).toHaveLength(5);
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
		expect(panel.getGeometry()).toEqual({
			x: 0,
			y: 0,
			width: 32,
			height: 5,
			rows: [
				{ x: 1, y: 1, width: 30, height: 1, index: 0, value: "good" },
				{ x: 1, y: 2, width: 30, height: 1, index: 1, value: "no" },
			],
		});

		panel.handleInput("j");
		panel.handleInput("\r");
		panel.handleInput("3");
		panel.handleInput("\x1b");
		expect(selected).toEqual(["no", "yes"]);
		expect(cancelled).toBe(1);
		expect(renders).toBeGreaterThan(0);
		expect(
			new ActionPanel({
				theme: boundedTheme,
				keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
				title: "Too short",
				options: [{ value: "a", label: "A" }],
				maxHeight: 3,
				requestRender() {},
				onSelect() {},
				onCancel() {},
			}).render(30),
		).toEqual([]);
	});

	test("action panel hover highlights rows and primary click selects", () => {
		initializeTui();
		const selected: string[] = [];
		let renders = 0;
		const panelTheme = {
			...theme,
			bg: (_color: string, text: string) => `<selected>${text}</selected>`,
		} as Theme;
		const panel = new ActionPanel({
			theme: panelTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Actions",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			requestRender: () => {
				renders += 1;
			},
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});

		panel.render(30);
		expect(panel.handleMouse({ type: "enter", row: 2, col: 5 })).toBe(true);
		const hovered = panel.render(30)[2]!;
		expect(hovered).toContain(tuiTheme(panelTheme).bgAnsi("surface.selected"));
		expect(hovered).toContain("Beta");
		panel.handleMouse({ type: "press", row: 2, col: 5, button: 0 });
		panel.handleMouse({ type: "release", row: 2, col: 5, button: 0 });
		expect(selected).toEqual(["b"]);

		panel.handleMouse({ type: "move", row: 0, col: 5 });
		panel.handleMouse({ type: "leave", row: 0, col: 0 });
		expect(renders).toBeGreaterThanOrEqual(2);
	});

	test("action panel can separate click selection from explicit activation", () => {
		initializeTui();
		const selected: string[] = [];
		const activated: string[] = [];
		const panel = new ActionPanel({
			theme: { ...theme, bg: (_color: string, text: string) => text } as Theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "React",
			options: [
				{ value: "good", label: "Looks good" },
				{ value: "no", label: "Rejected" },
			],
			numberShortcuts: true,
			activateOnClick: false,
			requestRender() {},
			onSelectionChange: (value) => selected.push(value),
			onSelect: (value) => activated.push(value),
			onCancel() {},
		});

		panel.render(30);
		panel.handleMouse({ type: "press", row: 2, col: 5, button: 0 });
		panel.handleMouse({ type: "release", row: 2, col: 5, button: 0 });
		expect(panel.getSelectedValue()).toBe("no");
		expect(selected).toEqual(["no"]);
		expect(activated).toEqual([]);

		panel.handleInput("1");
		expect(activated).toEqual(["good"]);
	});

	test("action panel hosts and translates input to a structural footer", () => {
		initializeTui();
		const activated: string[] = [];
		const footer = new DialogButtonBar({
			theme: ansiTheme,
			buttons: [
				{ value: "cancel", label: "Cancel", foreground: "text.primary", background: "badge.neutral" },
				{ value: "add", label: "Add", foreground: "positive", background: "badge.positive", shortcuts: ["ctrl+d"] },
			],
			requestRender() {},
			onActivate: (value) => activated.push(value),
		});
		const panel = new ActionPanel({
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "React",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			activateOnClick: false,
			footer,
			maxHeight: 6,
			requestRender() {},
			onSelect() {},
			onCancel() {},
		});

		const rendered = panel.render(30);
		expect(rendered).toHaveLength(6);
		expect(stripTerminalSequences(rendered[3]!)).toBe("├────────────────────────────┤");
		expect(panel.getGeometry()?.footer).toEqual({ x: 1, y: 4, width: 28, height: 1 });
		expect(footer.getGeometry()?.buttons).toEqual([
			{ x: 10, y: 0, width: 8, height: 1, index: 0, value: "cancel" },
			{ x: 19, y: 0, width: 9, height: 1, index: 1, value: "add" },
		]);

		panel.handleMouse({ type: "press", row: 4, col: 25, button: 0 });
		panel.handleMouse({ type: "release", row: 4, col: 25, button: 0 });
		panel.handleInput("\x04");
		expect(activated).toEqual(["add", "add"]);

		panel.handleMouse({ type: "move", row: 1, col: 3 });
		expect(panel.handleMouse({ type: "leave", row: 0, col: 0 })).toBe(false);
	});

	test("styled panel and editor titles restore border ANSI around every border segment", () => {
		initializeTui();
		const overlay = new FullscreenOverlay(
			{ terminal: { rows: 4 }, requestRender() {} } as never,
			ansiTheme,
			{ render: () => ["content"], invalidate() {} },
			"Settings",
		);
		const overlayHeader = overlay.render(32)[0]!;
		expect(stripTerminalSequences(overlayHeader)).toBe("╭─ Settings ───────────────────╮");
		const colors = tuiTheme(ansiTheme);
		expect(
			overlayHeader.startsWith(`${colors.fgAnsi("border")}╭─\x1b[39m ${colors.fgAnsi("accent")}Settings\x1b[39m `),
		).toBe(true);

		const panel = new ActionPanel({
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "React",
			options: Array.from({ length: 7 }, (_, index) => ({ value: `${index}`, label: `Option ${index}` })),
			requestRender() {},
			onSelect() {},
			onCancel() {},
		});
		const header = panel.render(32)[0]!;
		expect(stripTerminalSequences(header)).toBe("╭─ React 1/7 ──────────────────╮");
		expect(header.startsWith(`${colors.fgAnsi("border")}╭─ `)).toBe(true);
		expect(header).toContain(`\x1b[39m${colors.fgAnsi("border")} ─`);

		const compactPanel = new ActionPanel({
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Compact",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			showHint: false,
			maxHeight: 4,
			requestRender() {},
			onSelect() {},
			onCancel() {},
		});
		const compact = compactPanel.render(32);
		expect(compact).toHaveLength(4);
		expect(stripTerminalSequences(compact.join("\n"))).not.toContain("navigate");
		expect(compactPanel.getGeometry()?.rows).toHaveLength(2);

		const editor = new FramedEditorOverlay({
			tui: { terminal: { rows: 20, columns: 80 }, requestRender() {} } as never,
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Annotate",
			onSubmit() {},
			onCancel() {},
		});
		const editorHeader = editor.render(32)[0]!;
		expect(editorHeader.startsWith(`${colors.fgAnsi("border")}╭─ `)).toBe(true);
		expect(editorHeader).toContain(`\x1b[39m${colors.fgAnsi("border")} ─`);
		const editorLines = editor.render(32);
		expect(editorLines.some((line) => line.includes(CURSOR_MARKER))).toBe(false);
		expect(editorLines.some((line) => line.includes("\x1b[7m") && line.includes("\x1b[27m"))).toBe(false);
		editor.focused = true;
		expect(
			editor
				.render(32)
				.some((line) => line.includes(CURSOR_MARKER) && line.includes("\x1b[7m") && line.includes("\x1b[27m")),
		).toBe(true);

		const picker = new PickerPanel({
			tui: { terminal: { rows: 20, columns: 80 }, requestRender() {} } as never,
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Models",
			options: [{ value: "one", label: "One" }],
			onSelect() {},
			onCancel() {},
		});
		const pickerHeader = picker.render(32)[0]!;
		expect(pickerHeader.startsWith(`${colors.fgAnsi("border")}╭\x1b[39m${colors.fgAnsi("border")}─ \x1b[39m`)).toBe(
			true,
		);
	});

	test("dialog buttons expose exact geometry, semantic colors, hover, click, and shortcuts", () => {
		const activated: string[] = [];
		let renders = 0;
		const buttons = new DialogButtonBar({
			theme: ansiTheme,
			leading: () => "Hint that truncates",
			buttons: [
				{ value: "delete", label: "Delete", foreground: "negative", background: "badge.negative", align: "start" },
				{
					value: "cancel",
					label: "Cancel",
					foreground: "text.muted",
					background: "badge.neutral",
					shortcuts: ["escape"],
				},
				{
					value: "add",
					label: () => "Add",
					foreground: "positive",
					background: "badge.positive",
					shortcuts: ["ctrl+d"],
				},
			],
			requestRender: () => {
				renders += 1;
			},
			onActivate: (value) => activated.push(value),
		});

		const normal = buttons.render(40)[0]!;
		expect(visibleWidth(normal)).toBe(40);
		expect(normal).toContain("\x1b[48;2;");
		expect(stripTerminalSequences(normal)).toContain(" Delete ");
		expect(stripTerminalSequences(normal)).toContain(" Cancel ");
		expect(stripTerminalSequences(normal)).toContain(" Add ");
		expect(stripTerminalSequences(normal)).toContain("Hint that");
		expect(stripTerminalSequences(normal)).toContain("Cancel ⎋");
		expect(stripTerminalSequences(normal)).toContain("Add ⌃ 🅳");
		expect(buttons.getGeometry()).toEqual({
			x: 0,
			y: 0,
			width: 40,
			height: 1,
			buttons: [
				{ x: 0, y: 0, width: 8, height: 1, index: 0, value: "delete" },
				{ x: 20, y: 0, width: 10, height: 1, index: 1, value: "cancel" },
				{ x: 31, y: 0, width: 9, height: 1, index: 2, value: "add" },
			],
		});

		expect(buttons.handleMouse({ type: "enter", row: 0, col: 22 })).toBe(true);
		const hovered = buttons.render(40)[0]!;
		expect(stripTerminalSequences(hovered)).toBe(stripTerminalSequences(normal));
		expect(hovered).not.toBe(normal);
		expect(hovered).toContain(
			tuiTheme(ansiTheme).bgAnsi(tuiTheme(ansiTheme).contrastBackground(tuiTheme(ansiTheme).color("badge.neutral"))),
		);
		buttons.handleMouse({ type: "press", row: 0, col: 22, button: 0 });
		buttons.handleMouse({ type: "release", row: 0, col: 22, button: 0 });
		buttons.handleInput("\x04");
		expect(activated).toEqual(["cancel", "add"]);
		expect(renders).toBeGreaterThan(0);
	});

	test("powerline buttons use rounded caps in their rendered and hit geometry", () => {
		configureTuiAppearance({ powerlineButtons: true });
		const buttons = new DialogButtonBar({
			theme: ansiTheme,
			buttons: [
				{
					value: "save",
					label: "Save",
					foreground: "positive",
					background: "badge.positive",
					shortcuts: ["enter"],
				},
			],
			requestRender() {},
			onActivate() {},
		});

		const rendered = buttons.render(20)[0]!;
		const colors = tuiTheme(ansiTheme);
		expect(stripTerminalSequences(rendered)).toContain(" Save ⏎ ");
		expect(rendered).toContain(colors.bgAnsi("badge.positive"));
		expect(rendered).not.toContain(colors.bgAnsi("badge.neutral"));
		expect(buttons.getGeometry()?.buttons).toEqual([{ x: 10, y: 0, width: 10, height: 1, index: 0, value: "save" }]);
		expect(buttons.handleMouse({ type: "press", row: 0, col: 10, button: 0 })).toBe(true);
		expect(buttons.handleMouse({ type: "release", row: 0, col: 19, button: 0 })).toBe(true);
	});

	test("powerline separators derive exact truecolor and 256-color cap foregrounds", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const pillTheme = (backgroundAnsi: string): Theme =>
			({
				getBgAnsi: () => backgroundAnsi,
				bg: (_color: string, text: string) => `${backgroundAnsi}${text}\x1b[49m`,
				fg: (_color: string, text: string) => `\x1b[38;5;15m${text}\x1b[39m`,
			}) as never;

		const truecolorTheme = pillTheme("\x1b[48;2;10;20;30m");
		const truecolorColors = tuiTheme(truecolorTheme);
		const truecolorColor = truecolorColors.color({ hue: "blue", shade: 2 });
		const truecolor = renderPill(truecolorTheme, { icon: false, label: " Add " }, truecolorColor, "text.primary");
		const truecolorBackground = truecolorColors.bgAnsi(truecolorColor);
		expect(truecolor).toContain(truecolorBackground.replace("[48;", "[38;"));
		expect(visibleWidth(truecolor)).toBe(7);

		const indexedTheme = pillTheme("\x1b[48;5;240m");
		const indexedColors = tuiTheme(indexedTheme);
		const indexedColor = indexedColors.color({ hue: "gray", shade: 1 });
		const indexed = renderPill(indexedTheme, { icon: false, label: "OK" }, indexedColor, "text.primary");
		const indexedBackground = indexedColors.bgAnsi(indexedColor);
		expect(indexed.startsWith(`${indexedBackground.replace("[48;", "[38;")}`)).toBe(true);
		expect(indexed.endsWith(`${indexedBackground.replace("[48;", "[38;")}\x1b[39m\x1b[49m`)).toBe(true);
		expect(visibleWidth(indexed)).toBe(4);

		const nestedTheme = {
			getBgAnsi: (color: string) => (color === "userMessageBg" ? "\x1b[48;5;238m" : "\x1b[48;5;240m"),
			bg: (_color: string, text: string) => `\x1b[48;5;240m${text}\x1b[49m`,
			fg: (_color: string, text: string) => `\x1b[38;5;15m${text}\x1b[39m`,
		} as never;
		const nestedColors = tuiTheme(nestedTheme);
		const nestedColor = nestedColors.color({ hue: "gray", shade: 1 });
		const nested = renderPill(
			nestedTheme,
			{ icon: false, label: "OK" },
			nestedColor,
			"text.primary",
			undefined,
			"\x1b[48;5;238m",
		);
		const nestedBackground = nestedColors.bgAnsi(nestedColor);
		expect(nested).toContain(`\x1b[48;5;238m${nestedBackground.replace("[48;", "[38;")}`);
	});

	test("tracks the destination background and restores it after a pill", () => {
		expect(backgroundAnsiAtColumn("\x1b[48;5;8mabc\x1b[49mdef", 0)).toBe("\x1b[48;5;8m");
		expect(backgroundAnsiAtColumn("\x1b[48;5;8mabc\x1b[49mdef", 1)).toBe("\x1b[48;5;8m");
		expect(backgroundAnsiAtColumn("\x1b[48;5;8mabc\x1b[49mdef", 4)).toBe("\x1b[49m");
		expect(backgroundAnsiAtColumn("\x1b[38;2;45;45;45mabc", 1)).toBe("\x1b[49m");
		expect(backgroundAnsiAtColumn("\x1b[48;5;8m\x1b[38;2;45;45;45mabc", 1)).toBe("\x1b[48;5;8m");
		expect(backgroundAnsiAtColumn("\x1b[48;2;40;46;68m\x1b[38;2;95;210;255mabc", 1)).toBe("\x1b[48;2;40;46;68m");
		const theme = {
			getBgAnsi: (color: string) => (color === "selectedBg" ? "\x1b[48;5;8m" : "\x1b[48;5;4m"),
			bg: (_color: string, text: string) => text,
			fg: (_color: string, text: string) => text,
		} as never;
		const colors = tuiTheme(theme);
		const selected = contrastingPillBackground(theme, colors.bgAnsi("surface.selected"));
		const neutral = contrastingPillBackground(theme, colors.bgAnsi("badge.neutral"));
		const defaultBackground = contrastingPillBackground(theme, "\x1b[49m");
		expect(typeof selected).toBe("object");
		expect(typeof neutral).toBe("object");
		expect(typeof defaultBackground).toBe("object");
		expect(colors.bgAnsi(selected)).not.toBe(colors.bgAnsi(neutral));
		expect(renderPill(theme, { icon: false, label: "OK" }, selected, "text.primary")).toContain(
			colors.bgAnsi(selected),
		);
		const pill = renderPill(
			theme,
			{ icon: false, label: "OK" },
			"badge.neutral",
			"text.primary",
			undefined,
			"\x1b[48;5;8m",
		);
		expect(pill).toStartWith("\x1b[48;5;8m");
		expect(pill).toEndWith("\x1b[48;5;8m");
	});

	test("powerline separators use flat Unicode blocks when disabled", () => {
		configureTuiAppearance({ powerline: false });
		const pillTheme = {
			getBgAnsi: () => "\x1b[48;5;240m",
			bg: (_color: string, text: string) => text,
			fg: (_color: string, text: string) => text,
		} as never;

		const rendered = renderPill(pillTheme, { icon: false, label: "OK" }, "badge.neutral", "text.primary");
		expect(rendered).toContain("▐");
		expect(rendered).toContain("▌");
		expect(rendered).not.toContain("");
		expect(rendered).not.toContain("");
	});

	test("anchored overlays prefer below/right, flip, and clamp to terminal bounds", () => {
		expect(
			placeAnchoredOverlay({
				terminalCols: 80,
				terminalRows: 24,
				anchorRow: 4,
				anchorCol: 10,
				desiredWidth: 30,
				height: 6,
				gap: 1,
			}),
		).toEqual({
			rect: { x: 11, y: 5, width: 30, height: 6 },
			options: { anchor: "top-left", row: 5, col: 11, width: 30, maxHeight: 6, margin: 0 },
		});

		expect(
			placeAnchoredOverlay({
				terminalCols: 80,
				terminalRows: 24,
				anchorRow: 22,
				anchorCol: 78,
				desiredWidth: 30,
				height: 6,
			}),
		).toEqual({
			rect: { x: 48, y: 16, width: 30, height: 6 },
			options: { anchor: "top-left", row: 16, col: 48, width: 30, maxHeight: 6, margin: 0 },
		});

		expect(
			placeAnchoredOverlay({
				terminalCols: 8,
				terminalRows: 4,
				anchorRow: 100,
				anchorCol: 100,
				desiredWidth: 20,
				height: 10,
			}),
		).toEqual({
			rect: { x: 0, y: 0, width: 8, height: 4 },
			options: { anchor: "top-left", row: 0, col: 0, width: 8, maxHeight: 4, margin: 0 },
		});

		expect(
			placeAnchoredOverlay({
				terminalCols: 80,
				terminalRows: 24,
				anchorRow: 22,
				anchorCol: 40,
				desiredWidth: 30,
				height: 6,
				horizontalPlacement: "center",
			}),
		).toEqual({
			rect: { x: 25, y: 16, width: 30, height: 6 },
			options: { anchor: "top-left", row: 16, col: 25, width: 30, maxHeight: 6, margin: 0 },
		});
	});

	test("transient pills center above their anchor, flip, clamp, and composite semantic feedback", () => {
		expect(placeTransientPill({ anchor: { row: 3, col: 10 }, width: 8, screenWidth: 20, screenHeight: 5 })).toEqual({
			x: 7,
			y: 2,
			width: 8,
			height: 1,
		});
		expect(placeTransientPill({ anchor: { row: 0, col: 1 }, width: 8, screenWidth: 20, screenHeight: 5 })).toEqual({
			x: 0,
			y: 1,
			width: 8,
			height: 1,
		});

		const pill = new TransientPill({ theme: ansiTheme, requestRender() {}, durationMs: 60_000 });
		pill.show({ label: "No text selected to annotate.", icon: "warning", tone: "warning" }, { row: 2, col: 9 });
		const rendered = pill.composite(
			Array.from({ length: 4 }, () => " ".repeat(50)),
			{
				width: 50,
				height: 4,
			},
		);
		pill.dispose();
		expect(stripTerminalSequences(rendered.join("\n"))).toContain("⚠ No text selected to annotate.");
		expect(rendered.join("\n")).toContain(tuiTheme(ansiTheme).bgAnsi("badge.warning"));
	});

	test("framed editor delegates multiline editing, submit, and cancel to Pi Editor", () => {
		initializeTui();
		const submitted: string[] = [];
		let cancelled = 0;
		const tui = {
			terminal: { rows: 20, columns: 80 },
			requestRender() {},
		} as never;
		const editor = new FramedEditorOverlay({
			tui,
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Comment",
			prefill: "first",
			maxWidth: 30,
			maxHeight: 8,
			onSubmit: (text) => submitted.push(text),
			onCancel: () => {
				cancelled += 1;
			},
		});

		editor.handleInput("\n");
		for (const character of "second") editor.handleInput(character);
		expect(editor.getText()).toBe("first\nsecond");
		expect(editor.render(80).every((line) => visibleWidth(line) <= 30)).toBe(true);
		editor.handleInput("\r");
		expect(submitted).toEqual(["first\nsecond"]);
		editor.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	test("framed editor hides native borders and keeps its cursor row visible", () => {
		initializeTui();
		const editor = new FramedEditorOverlay({
			tui: { terminal: { rows: 20, columns: 80 }, requestRender() {} } as never,
			theme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Comment",
			prefill: ["one", "two", "three", "four"].join("\n"),
			editorBorders: false,
			maxWidth: 20,
			maxHeight: 5,
			onSubmit() {},
			onCancel() {},
		});

		const visibleContent = (lines: string[]) =>
			lines.slice(1, -1).map((line) => stripTerminalSequences(line).slice(1, -1).trim());
		expect(visibleContent(editor.render(80))).toEqual(["one", "two", "three"]);

		editor.focused = true;
		expect(visibleContent(editor.render(80))).toEqual(["two", "three", "four"]);
	});

	test("framed editor owns structural footer layout, shortcuts, and translated mouse lifecycle", () => {
		initializeTui();
		const activated: string[] = [];
		const footer = new DialogButtonBar({
			theme: ansiTheme,
			buttons: [
				{ value: "add", label: "Add", foreground: "positive", background: "badge.positive", shortcuts: ["ctrl+d"] },
			],
			requestRender() {},
			onActivate: (value) => activated.push(value),
		});
		const editor = new FramedEditorOverlay({
			tui: { terminal: { rows: 20, columns: 80 }, requestRender() {} } as never,
			theme: ansiTheme,
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			title: "Annotate",
			prefill: "comment",
			footer,
			editorBorders: false,
			maxWidth: 30,
			maxHeight: 8,
			onSubmit() {},
			onCancel() {},
		});

		const lines = editor.render(80);
		const geometry = editor.getGeometry();
		expect(lines).toHaveLength(5);
		expect(stripTerminalSequences(lines[1]!)).toContain("comment");
		expect(stripTerminalSequences(lines[2]!)).toBe("├────────────────────────────┤");
		expect(geometry?.footer).toEqual({ x: 1, y: 3, width: 28, height: 1 });
		expect(editor.getText()).toBe("comment");

		editor.handleMouse({ type: "press", row: 3, col: 25, button: 0 });
		editor.handleMouse({ type: "release", row: 3, col: 25, button: 0 });
		editor.handleInput("\x04");
		expect(activated).toEqual(["add", "add"]);
		expect(editor.handleMouse({ type: "move", row: 2, col: 2 })).toBe(false);
	});

	test("multi-select saves order and warns before discarding changes", () => {
		initializeTui();
		const saved: string[][] = [];
		let cancelled = false;
		const select = new MultiSelect({
			title: "Models",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			value: ["b", "a"],
			ordered: true,
			theme,
			onSave: (value) => saved.push(value),
			onCancel: () => {
				cancelled = true;
			},
		});

		select.handleInput("l");
		expect(stripTerminalSequences(select.render(60).join("\n")).indexOf("A")).toBeLessThan(
			stripTerminalSequences(select.render(60).join("\n")).indexOf("B"),
		);
		select.handleInput("\x1b");
		expect(select.render(60).join("\n")).toContain("Unsaved changes");
		expect(cancelled).toBe(false);
		select.handleInput("\r");
		expect(saved).toEqual([["a", "b"]]);
	});

	test("multi-select wraps descriptions below option labels", () => {
		initializeTui();
		const select = new MultiSelect({
			title: "Tools",
			options: [
				{
					value: "exec",
					label: "exec_command",
					description: "Run a shell command with bounded output and persistent process support.",
				},
			],
			value: ["exec"],
			descriptionLayout: "below",
			theme,
			onSave() {},
			onCancel() {},
		});

		const lines = select.render(32).map(stripTerminalSequences);
		const labelRow = lines.findIndex((line) => line.includes("exec_command"));
		expect(labelRow).toBeGreaterThanOrEqual(0);
		expect(lines[labelRow]).not.toContain("Run a shell");
		expect(lines.slice(labelRow + 1, -2).join(" ")).toContain("Run a shell command with");
		expect(lines.slice(labelRow + 1, -2).join(" ")).toContain("bounded output");
		expect(lines.every((line) => line.length <= 32)).toBe(true);
	});

	test("multi-select keeps wrapped options and actions inside its height budget", () => {
		initializeTui();
		const select = new MultiSelect({
			title: "Tools",
			description: "Choose tools.",
			options: Array.from({ length: 8 }, (_, index) => ({
				value: `tool-${index}`,
				label: `tool-${index}`,
				description: `Description for tool ${index} that wraps onto another line at this width.`,
			})),
			value: [],
			descriptionLayout: "below",
			maxHeight: 10,
			theme,
			onSave: () => {},
			onCancel: () => {},
		});

		const initial = select.render(36);
		expect(initial.length).toBeLessThanOrEqual(10);
		expect(stripTerminalSequences(initial.join("\n"))).toContain("█");
		for (let index = 0; index < 7; index += 1) select.handleInput("j");
		const final = select.render(36);
		const rendered = stripTerminalSequences(final.join("\n"));
		expect(final).toHaveLength(initial.length);
		expect(rendered).toContain("tool-7");
		expect(rendered).not.toContain("tool-0");
		expect(rendered).toContain("Save");
	});

	test("multi-select filters labels and descriptions without changing its height", () => {
		initializeTui();
		const select = new MultiSelect({
			title: "Tools",
			options: [
				{ value: "shell", label: "exec_command", description: "Run a shell command." },
				{ value: "patch", label: "apply_patch", description: "Edit workspace files." },
				{ value: "search", label: "tool_search", description: "Find deferred tools." },
			],
			value: [],
			descriptionLayout: "below",
			maxHeight: 12,
			theme,
			onSave() {},
			onCancel() {},
		});

		const initialHeight = select.render(40).length;
		select.handleInput("/");
		for (const character of "workspace") select.handleInput(character);
		const filtered = stripTerminalSequences(select.render(40).join("\n"));
		expect(filtered).toContain("apply_patch");
		expect(filtered).not.toContain("exec_command");
		expect(filtered).not.toContain("tool_search");
		expect(select.render(40)).toHaveLength(initialHeight);
	});
});
