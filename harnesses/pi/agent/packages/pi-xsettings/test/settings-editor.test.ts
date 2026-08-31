import { afterEach, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	type DialogHost,
	icon,
	sharedMotionScheduler,
	type TuiTitleSource,
	tuiTheme,
} from "pi-libtui";
import { Type } from "typebox";
import type { SettingValue } from "../src/protocol/settings.ts";
import { type SettingField, SettingsEditor } from "../src/ui/settings-editor.ts";

describe("xsettings editor", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
		underline: (text: string) => text,
	} as Theme;

	function initializeTui(): void {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	}

	test("renders each section heading once instead of repeating it for every item", () => {
		initializeTui();
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "Display",
					label: "First",
					description: "First setting.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "second",
					section: "Display",
					label: "Second",
					description: "Second setting.",
					type: "boolean",
					value: true,
					defaultValue: false,
					configured: true,
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
		);

		const rendered = stripTerminalSequences(editor.render(80).join("\n"));
		expect(rendered.match(/Display/g)).toHaveLength(1);
		expect(rendered).toContain("First");
		expect(rendered).toContain("Second");
	});

	test("colors enum values and picker labels from option metadata", () => {
		initializeTui();
		const color = { hue: "cyan", shade: 3 } as const;
		const editor = new SettingsEditor(
			[
				{
					id: "extensions.pi-demo.contextWindow",
					section: "Demo",
					label: "Context window",
					description: "Choose a context window.",
					type: "enum",
					value: "balanced",
					defaultValue: "balanced",
					configured: false,
					options: [{ value: "balanced", label: "Balanced (272k)", description: "Default window.", color }],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
		);
		const colorAnsi = tuiTheme(theme).fgAnsi(color);

		expect(editor.render(80).join("\n")).toContain(colorAnsi);
		expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("Balanced (272k)");
		editor.handleInput("\r");
		expect(editor.render(80).join("\n")).toContain(colorAnsi);
	});

	test("renders editor composition candidates through the production renderer", () => {
		initializeTui();
		const style = {
			surface: "editor",
			top: "half-block",
			bottom: "none",
			leftRail: "animated",
			rightRail: "static",
			promptMarker: ["❩", "❫", "❭", "❯", "❱"],
			promptMarkerMotion: "always",
			bottomStatus: true,
			statusSeparator: "dot",
			statusBand: "transparent",
			inactiveRailTone: "accent",
		} as const;
		const editor = new SettingsEditor(
			[
				{
					id: "extensions.pi-custom-editor.preset",
					preview: "editor-composition",
					section: "Editor layout",
					label: "Preset",
					description: "Choose a composition.",
					type: "enum",
					value: "compact",
					defaultValue: "compact",
					configured: false,
					options: [
						{
							value: "compact",
							label: "Compact",
							preview: {
								style,
								topStatus: { left: "forge · GPT-5.6 Sol", right: "~/src/agents · next" },
								bottomStatus: { left: "agents", right: "6.3%/272K" },
							},
						},
						{
							value: "borderless",
							label: "Borderless",
							preview: {
								style: { ...style, surface: "transparent", top: "none", leftRail: "off", rightRail: "off" },
								topStatus: { left: "forge · GPT-5.6 Sol", right: "~/src/agents · next" },
								bottomStatus: { left: "agents", right: "6.3%/272K" },
							},
						},
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
		);

		editor.handleInput("\r");
		const rendered = editor.render(80).map(stripTerminalSequences).join("\n");
		expect(rendered).toStartWith("Preset\n");
		expect(rendered).toContain("Ask anything, edit files, run tools");
		expect(rendered).toContain("6.3%/272K");
		expect(rendered).not.toContain("Save");
		expect(rendered).not.toContain("Cancel");
		editor.handleInput("\x1b");
	});

	test("groups split sections while preserving section and field order", () => {
		initializeTui();
		const field = (id: string, section: string, label: string): SettingField => ({
			id,
			section,
			label,
			description: `${label} setting.`,
			type: "boolean",
			value: false,
			defaultValue: false,
			configured: false,
		});
		const editor = new SettingsEditor(
			[
				field("display-one", "Display", "First option"),
				field("markdown", "Markdown", "Markdown option"),
				field("display-two", "Display", "Second option"),
			],
			theme,
			() => {},
			() => {},
			() => {},
		);

		const rendered = stripTerminalSequences(editor.render(100).join("\n"));
		expect(rendered.match(/Display/g)).toHaveLength(1);
		expect(rendered.indexOf("First option")).toBeLessThan(rendered.indexOf("Second option"));
		expect(rendered.indexOf("Second option")).toBeLessThan(rendered.indexOf("Markdown option"));
	});

	test("renders every setting as a labeled control with persistent help text", () => {
		initializeTui();
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "Display",
					label: "Cache miss notices",
					description: "Show significant prompt-cache misses.",
					type: "boolean",
					value: true,
					defaultValue: false,
					configured: true,
				},
				{
					id: "second",
					section: "Display",
					label: "Compact threshold",
					description: "Compact before the context fills.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			10,
		);

		const narrow = editor.render(64).map(stripTerminalSequences);
		const narrowDescriptionRow = narrow.findIndex((line) => line.includes("Show significant prompt-cache misses."));
		expect(narrowDescriptionRow).toBeGreaterThan(narrow.findIndex((line) => line.includes("Cache miss notices")));
		expect(narrowDescriptionRow).toBeLessThan(narrow.findIndex((line) => line.includes("Compact threshold")));
		expect(narrow.join("\n")).toContain("Compact before the context fills.");

		const renderedWide = editor.render(120);
		const contrast = tuiTheme(theme).contrastBackground(tuiTheme(theme).color("surface.selected"));
		const selectedDescription = renderedWide.find((line) => stripTerminalSequences(line).includes("Show significant"));
		expect(selectedDescription).toContain(tuiTheme(theme).fgAnsi(contrast));
		const wide = renderedWide.map(stripTerminalSequences);
		const selectedRow = wide.findIndex((line) => line.includes("Cache miss notices"));
		expect(wide[selectedRow + 1]).toContain("Show significant prompt-cache misses.");
		expect(wide).toContain("▄".repeat(120));
		expect(wide).toContain("▀".repeat(120));
		expect(wide.filter((line) => line === "─".repeat(120))).toHaveLength(0);
		editor.handleInput("j");
		const moved = editor.render(120).map(stripTerminalSequences);
		expect(moved.filter(Boolean)).toHaveLength(wide.filter(Boolean).length);
		expect(moved).toContain("▄".repeat(120));
		expect(moved.filter((line) => line === "─".repeat(120))).toHaveLength(1);
	});

	test("renders setting controls as Powerline pills when button pills are enabled", () => {
		initializeTui();
		configureTuiAppearance({ powerline: false, powerlineButtons: true });
		const editor = new SettingsEditor(
			[
				{
					id: "theme",
					section: "Style",
					label: "Theme",
					description: "Color theme used by Pi.",
					type: "enum",
					value: "dark",
					defaultValue: "dark",
					configured: false,
					options: [{ value: "dark", label: "Dark" }],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
		);

		const rendered = stripTerminalSequences(editor.render(80).join("\n"));
		expect(rendered).toContain("");
		expect(rendered).toContain("");
	});

	test("renders ordered selections in their actual order after moving them", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "models",
					section: "Models",
					label: "Models",
					description: "Ordered models.",
					type: "multi-enum",
					value: ["b", "a"],
					defaultValue: [],
					configured: true,
					ordered: true,
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		editor.handleInput("\r");
		const before = stripTerminalSequences(editor.render(80).join("\n"));
		expect(before.indexOf("B")).toBeLessThan(before.indexOf("A"));
		editor.handleInput("l");
		const after = stripTerminalSequences(editor.render(80).join("\n"));
		expect(after.indexOf("A")).toBeLessThan(after.indexOf("B"));
		expect(changes).toEqual([]);
		editor.handleInput("\r");
		expect(changes).toEqual([["models", ["a", "b"]]]);
	});

	test("summarizes model-facing tool manuals in tool pickers", () => {
		initializeTui();
		const editor = new SettingsEditor(
			[
				{
					id: "deferred-tools",
					category: "tools",
					section: "Tool Search",
					label: "Deferred tools",
					description: "Checked tools are hidden until tool_search loads them.",
					type: "multi-enum",
					value: [],
					defaultValue: [],
					configured: true,
					ordered: false,
					options: [
						{
							value: "exec",
							label: "exec",
							description:
								"Run JavaScript code to orchestrate tool calls. More model guidance.\n- All nested tools are available on `tools`.\n- Runs raw JavaScript.",
						},
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
		);

		editor.handleInput("\r");
		const rendered = stripTerminalSequences(editor.render(80).join("\n"));
		expect(rendered).toContain("Run JavaScript code to orchestrate tool calls.");
		expect(rendered).not.toContain("More model guidance");
		expect(rendered).not.toContain("All nested tools");
	});

	test("uses compact enum selects and inline string editing", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const enumEditor = new SettingsEditor(
			[
				{
					id: "mode",
					section: "General",
					label: "Mode",
					description: "Choose a mode.",
					type: "enum",
					value: "default",
					defaultValue: "default",
					configured: false,
					options: [
						{ value: "default", label: "Default", description: "Everything" },
						{ value: "minimal", label: "Minimal", description: "Path only" },
					],
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		enumEditor.focused = true;
		enumEditor.handleInput("\r");
		expect(enumEditor.render(80).join("\n")).toContain(CURSOR_MARKER);
		expect(stripTerminalSequences(enumEditor.render(80).join("\n"))).not.toContain("╭");
		expect(stripTerminalSequences(enumEditor.render(80).join("\n"))).not.toContain("Save");
		enumEditor.handleInput("m");
		enumEditor.handleInput("i");
		enumEditor.handleInput("n");
		enumEditor.handleInput("\r");
		expect(changes).toContainEqual(["mode", "minimal"]);

		const stringEditor = new SettingsEditor(
			[
				{
					id: "label",
					section: "General",
					label: "Label",
					description: "A short label.",
					type: "string",
					value: "old",
					defaultValue: "",
					configured: true,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);
		stringEditor.handleInput("\r");
		stringEditor.handleInput("\x0b");
		stringEditor.handleInput("new");
		stringEditor.handleInput("\r");
		expect(changes).toContainEqual(["label", "new"]);
	});

	test("previews enum candidates and restores the original value on cancel", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const previews: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "pi.theme",
					section: "Style",
					label: "Theme",
					description: "Color theme.",
					type: "enum",
					value: "default",
					defaultValue: "default",
					configured: false,
					options: [
						{ value: "default", label: "Default" },
						{ value: "night", label: "Night" },
					],
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
			undefined,
			(id, value) => previews.push([id, value]),
		);

		editor.handleInput("\r");
		editor.handleInput("n");
		expect(previews).toEqual([["pi.theme", "night"]]);
		editor.handleInput("\x1b");
		expect(previews).toEqual([
			["pi.theme", "night"],
			["pi.theme", "default"],
		]);
		expect(changes).toEqual([]);
	});

	test("previews independently combinable activity indicators and text effects", () => {
		initializeTui();
		const mountsBefore = sharedMotionScheduler.activeMountCount;
		configureTuiAppearance({ textEffect: "glow" });
		const markerEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-libtui.activityIndicator",
					preview: "activity-marker",
					section: "UI & Display",
					label: "Activity marker",
					description: "Choose a marker.",
					type: "enum",
					value: "spinner",
					defaultValue: "spinner",
					configured: false,
					options: [
						{ value: "off", label: "Off", description: "No marker." },
						{ value: "spinner", label: "Spinner", description: "Rotating marker." },
						{ value: "static", label: "Static", description: "Static marker." },
						{ value: "line", label: "Line", description: "Line marker." },
						{ value: "arc", label: "Arc", description: "Arc marker." },
						{ value: "dots", label: "Dots", description: "Moving dot marker." },
						{ value: "quadrants", label: "Quadrants", description: "Quadrant marker." },
						{ value: "sparkle", label: "Sparkle", description: "Sparkle marker." },
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
		);

		markerEditor.handleInput("\r");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore + 1);
		const lines: string[] = [];
		for (let index = 0; index < 9; index += 1) {
			lines.push(...markerEditor.render(100).map(stripTerminalSequences));
			markerEditor.handleInput("\x1b[B");
		}
		expect(lines.find((line) => line.includes("Off"))).not.toContain("● Off");
		expect(lines.find((line) => line.includes("Spinner"))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Spinner/u);
		expect(lines.find((line) => line.includes("Static"))).toContain("● Static");
		expect(lines.find((line) => line.includes("Line"))).toMatch(/[-\\|/] Line/u);
		expect(lines.find((line) => line.includes("Arc"))).toMatch(/[◜◠◝◞◡◟] Arc/u);
		expect(lines.find((line) => line.includes("Dots"))).toMatch(/[⠁⠂⠄⡀⢀⠠⠐⠈] Dots/u);
		expect(lines.find((line) => line.includes("Quadrants"))).toMatch(/[▖▘▝▗] Quadrants/u);
		expect(lines.find((line) => line.includes("Sparkle"))).toMatch(/[✦✧] Sparkle/u);
		markerEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		configureTuiAppearance({ activityIndicator: "static", textEffect: "off", pulseEffect: "color" });
		const overrideEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-exec-command.activityIndicator",
					preview: "activity-marker",
					section: "Animations",
					label: "Exec Command marker",
					description: "Override the shared marker.",
					type: "enum",
					value: "inherit",
					defaultValue: "inherit",
					configured: false,
					options: [
						{ value: "inherit", label: "Inherit", description: "Use the shared marker." },
						{ value: "off", label: "Off", description: "No marker." },
						{ value: "spinner", label: "Spinner", description: "Rotating marker." },
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
		);
		overrideEditor.handleInput("\r");
		const overrideLines = overrideEditor.render(100).map(stripTerminalSequences);
		expect(overrideLines.find((line) => line.includes("Inherit"))).toContain("● Inherit");
		expect(overrideLines.find((line) => line.includes("Off"))).not.toContain("● Off");
		overrideEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		configureTuiAppearance({ activityIndicator: "static", textEffect: "off", pulseEffect: "color" });
		const shimmerEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-libtui.textEffect",
					preview: "text-effect",
					section: "UI & Display",
					label: "Text effect",
					description: "Choose text motion.",
					type: "enum",
					value: "standard",
					defaultValue: "standard",
					configured: false,
					options: [
						{ value: "off", label: "Off", description: "Steady text." },
						{ value: "sweep", label: "Sweep", description: "Narrow highlight." },
						{ value: "glow", label: "Glow", description: "Broad highlight." },
						{ value: "rainbow", label: "Rainbow", description: "Color wave." },
						{ value: "rainbow-glow", label: "Rainbow glow", description: "Color glow." },
						{ value: "lightning", label: "Lightning", description: "Fast strike." },
						{ value: "aurora", label: "Aurora wave", description: "Luminous wave." },
						{ value: "glitch", label: "Glitch", description: "Artifact flashes." },
						{ value: "crush", label: "Crush", description: "Resolving artifacts." },
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			28,
			[],
			undefined,
			undefined,
			() => {},
		);
		shimmerEditor.handleInput("\r");
		const shimmerLines = shimmerEditor.render(100);
		const strippedShimmerLines = shimmerLines.map(stripTerminalSequences);
		const baseShimmerLines = strippedShimmerLines.map((line) => line.normalize("NFD").replace(/\p{M}/gu, ""));
		const previewLabels = ["Off", "Sweep", "Glow", "Rainbow", "Rainbow glow", "Lightning"];
		expect(previewLabels.filter((label) => baseShimmerLines.some((line) => line.includes(label)))).toEqual(
			previewLabels,
		);
		shimmerEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		const lineEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-libtui.statusPresentation",
					preview: "status-presentation",
					section: "Animations",
					label: "Status presentation",
					description: "Choose the inline composition or an exclusive presentation.",
					type: "enum",
					value: "off",
					defaultValue: "off",
					configured: false,
					options: [
						{ value: "standard", label: "Standard" },
						{ value: "neural-pulse", label: "Neural pulse" },
						{ value: "plasma-wave", label: "Plasma wave" },
						{ value: "pacman", label: "Pac-Man" },
						{ value: "starfield", label: "Starfield" },
						{ value: "block-wave", label: "Block wave" },
						{ value: "conveyor", label: "Conveyor" },
						{ value: "accordion", label: "Accordion" },
					],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
			18,
			[],
			undefined,
			undefined,
			() => {},
		);
		lineEditor.handleInput("\r");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore + 1);
		const lineLines = lineEditor.render(120).map(stripTerminalSequences);
		expect(lineLines.some((line) => line.includes("legacy"))).toBe(false);
		expect(lineLines.find((line) => line.includes("Standard"))).not.toMatch(/[█▓▒]/u);
		expect(lineLines.find((line) => line.includes("Neural pulse"))).toMatch(/[●○].*Neural pulse/u);
		expect(lineLines.find((line) => line.includes("Pac-Man"))).toMatch(/[ᗧC].*Pac-Man/u);
		expect(lineLines.find((line) => line.includes("Block wave"))).toMatch(/[█▓▒].*Block wave/u);
		lineEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		configureTuiAppearance({ activityIndicator: "line", textEffect: "glow", animationSpeed: "normal" });
		for (const field of [
			{
				id: "extensions.pi-libtui.animationSpeed",
				preview: "animation-speed",
				label: "Animation speed",
				value: "normal",
				options: [
					{ value: "slow", label: "Slow" },
					{ value: "relaxed", label: "Relaxed" },
					{ value: "normal", label: "Normal" },
					{ value: "fast", label: "Fast" },
					{ value: "very-fast", label: "Very fast" },
				],
			},
			{
				id: "extensions.pi-libtui.animationSmoothness",
				preview: "animation-smoothness",
				label: "Animation smoothness",
				value: "balanced",
				options: [
					{ value: "economy", label: "Economy" },
					{ value: "balanced", label: "Balanced" },
					{ value: "smooth", label: "Smooth" },
					{ value: "ultra", label: "Ultra" },
				],
			},
		] as const) {
			const editor = new SettingsEditor(
				[
					{
						...field,
						section: "Animations",
						description: "Choose animation timing.",
						type: "enum",
						defaultValue: field.value,
						configured: false,
					},
				],
				theme,
				() => {},
				() => {},
				() => {},
				18,
				[],
				undefined,
				undefined,
				() => {},
			);
			editor.handleInput("\r");
			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore + 1);
			const timingLines = editor.render(100).map(stripTerminalSequences);
			for (const option of field.options)
				expect(timingLines.find((line) => line.includes(option.label))).toMatch(/[-\\|/] /u);
			expect(timingLines.join("\n")).not.toMatch(/\p{M}/u);
			editor.handleInput("\x1b");
			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);
		}
	});

	test("keeps compact selects local even when a shared dialog host exists", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		let dialog: Component | undefined;
		let parent: { row: number; col: number } | undefined;
		let dialogTitle: TuiTitleSource | undefined;
		let dialogWidth: number | string | undefined;
		let dialogMaxHeight: number | string | undefined;
		let closed = 0;
		const dialogs: DialogHost = {
			open(component, options) {
				dialog = component;
				parent = options?.parent;
				dialogTitle = options?.title;
				dialogWidth = options?.width;
				dialogMaxHeight = options?.maxHeight;
				return () => {
					closed += 1;
					dialog = undefined;
				};
			},
		};
		const editor = new SettingsEditor(
			[
				{
					id: "mode",
					section: "General",
					label: "Mode",
					description: "Choose a mode.",
					type: "enum",
					value: "default",
					defaultValue: "default",
					configured: false,
					options: [
						{ value: "default", label: "Default" },
						{ value: "minimal", label: "Minimal" },
					],
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
			18,
			[],
			undefined,
			dialogs,
		);

		editor.render(80);
		editor.handleInput("\r");
		expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("Mode");
		expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("Minimal");
		expect(dialog).toBeUndefined();
		expect(parent).toBeUndefined();
		expect(dialogTitle).toBeUndefined();
		expect(dialogWidth).toBeUndefined();
		expect(dialogMaxHeight).toBeUndefined();
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");

		expect(changes).toEqual([["mode", "minimal"]]);
		expect(closed).toBe(0);
		expect(dialog).toBeUndefined();
	});

	test("leaves focus and page navigation keys for the settings screen", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "a",
					section: "One",
					label: "A",
					description: "A.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "b",
					section: "Two",
					label: "B",
					description: "B.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		expect(editor.handleInput("\t")).toBe(false);
		expect(editor.handleInput("\x1b[Z")).toBe(false);
		expect(editor.handleInput("h")).toBe(false);
		expect(editor.handleInput("l")).toBe(false);
		editor.handleInput("\r");
		expect(changes).toEqual([["a", true]]);
	});

	test("saves multi-enums on Enter and Escape discards a changed draft", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "tools",
					section: "Tools",
					label: "Tools",
					description: "Enabled tools.",
					type: "multi-enum",
					value: [],
					defaultValue: [],
					configured: true,
					ordered: false,
					options: [{ value: "read", label: "Read" }],
				},
			],
			theme,
			(id, value) => changes.push([id, value]),
			() => {},
			() => {},
		);

		editor.handleInput("\r");
		expect(editor.render(80).join("\n")).toContain(icon("checkbox-off"));
		editor.handleInput(" ");
		expect(editor.render(80).join("\n")).toContain(icon("checkbox-on"));
		editor.handleInput("\x1b");
		expect(changes).toEqual([]);
		expect(editor.render(80).join("\n")).not.toContain("Unsaved changes");

		editor.handleInput("\r");
		editor.handleInput(" ");
		editor.handleInput("\r");
		expect(changes).toEqual([["tools", ["read"]]]);
	});

	test("exits an unchanged multi-enum without a warning", () => {
		initializeTui();
		const editor = new SettingsEditor(
			[
				{
					id: "tools",
					section: "Tools",
					label: "Tools",
					description: "Enabled tools.",
					type: "multi-enum",
					value: ["read"],
					defaultValue: [],
					configured: true,
					ordered: false,
					options: [{ value: "read", label: "Read" }],
				},
			],
			theme,
			() => {},
			() => {},
			() => {},
		);

		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(editor.render(80).join("\n")).not.toContain("Unsaved changes");
	});

	test("shows default values as muted, configured values as headings, and resets with Backspace", () => {
		initializeTui();
		const recordingTheme = {
			...theme,
		} as Theme;
		const resets: string[] = [];
		const editor = new SettingsEditor(
			[
				{
					id: "default",
					section: "General",
					label: "Default",
					description: "Default value.",
					type: "enum",
					value: "safe",
					defaultValue: "safe",
					configured: false,
					options: [{ value: "safe", label: "Safe" }],
				},
				{
					id: "tools",
					section: "General",
					label: "Built-in tools",
					description: "Tools.",
					type: "multi-enum",
					value: [],
					defaultValue: [],
					configured: true,
					unsetOnlyDefault: true,
					unsetLabel: "all default tools",
					emptyLabel: "none",
					ordered: false,
					options: [],
				},
			],
			recordingTheme,
			() => {},
			(id) => resets.push(id),
			() => {},
		);

		const initial = editor.render(80).join("\n");
		const semantic = tuiTheme(recordingTheme);
		const defaultLine = initial.split("\n").find((line) => stripTerminalSequences(line).includes("Safe"));
		const configuredLine = initial.split("\n").find((line) => stripTerminalSequences(line).includes("none"));
		expect(defaultLine).toContain(semantic.fgAnsi("text.secondary"));
		expect(configuredLine).toContain(semantic.fgAnsi("heading"));
		editor.handleInput("j");
		editor.handleInput("\x7f");
		const rendered = editor.render(80).join("\n");
		expect(resets).toEqual(["tools"]);
		const resetLine = rendered.split("\n").find((line) => stripTerminalSequences(line).includes("all default tools"));
		expect(resetLine).toContain(semantic.fgAnsi("text.secondary"));
	});

	test("edits an ordered structured list with xsettings-owned inline UI", () => {
		initializeTui();
		const changes: SettingValue[] = [];
		const editor = new SettingsEditor(
			[
				{
					id: "roles",
					section: "Model Roles",
					label: "Roles",
					description: "Configure roles.",
					type: "list",
					value: [{ name: "a" }, { name: "b" }],
					defaultValue: [{ name: "a" }],
					schema: Type.Array(Type.Object({ name: Type.String() }), { minItems: 1 }),
					list: {
						itemLabel: "Role",
						identity: "name",
						uniqueIdentity: true,
						summary: [{ path: ["name"] }],
						minItems: 1,
						newItem: { name: "role" },
						fields: [{ key: "name", label: "Name", description: "Role name.", type: "string" }],
					},
					configured: true,
				},
			],
			theme,
			(_id, value) => changes.push(value),
			() => {},
			() => {},
		);

		expect(stripTerminalSequences(editor.render(80).join("\n"))).toContain("2 roles");
		editor.handleInput("\r");
		const inline = stripTerminalSequences(editor.render(80).join("\n"));
		expect(inline).toContain("Configure roles.");
		editor.handleInput("j");
		editor.handleInput("\x0b");
		editor.handleInput("\x13");
		expect(changes).toEqual([[{ name: "b" }, { name: "a" }]]);
	});
});
