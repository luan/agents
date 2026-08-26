import { afterEach, describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	type Component,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	icon,
	type DialogHost,
	sharedMotionScheduler,
	tuiTheme,
	type TuiTitleSource,
} from "pi-libtui";
import type { SettingValue } from "../src/protocol/settings.ts";
import { type SettingField, SettingsEditor } from "../src/ui/settings-editor.ts";
import { Type } from "typebox";

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

	test("keeps descriptions inline when they fit and otherwise anchors them at the bottom", () => {
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
			8,
		);

		const narrow = editor.render(64).map(stripTerminalSequences);
		const narrowDescriptionRow = narrow.findIndex((line) => line.includes("Show significant prompt-cache misses."));
		expect(narrowDescriptionRow).toBe(7);
		expect(narrow.findIndex((line) => line.includes("Compact threshold"))).toBeLessThan(narrowDescriptionRow);

		const wide = editor.render(120).map(stripTerminalSequences);
		const selectedRow = wide.findIndex((line) => line.includes("Cache miss notices"));
		expect(wide[selectedRow]).toContain("Show significant prompt-cache misses.");
		expect(wide.at(-1)).toBe("");
	});

	test("navigates with j and k and filters only after slash", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "General",
					label: "Cache diagnostics",
					description: "Show cache status.",
					type: "boolean",
					value: false,
					defaultValue: false,
					configured: false,
				},
				{
					id: "second",
					section: "Advanced",
					label: "Auto compaction",
					description: "Compact automatically near the context limit.",
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

		expect(stripTerminalSequences(editor.render(80).join("\n"))).not.toContain("/ ");
		editor.handleInput("j");
		editor.handleInput("\r");
		expect(changes).toEqual([["second", true]]);
		editor.handleInput("/");
		editor.handleInput("c");
		editor.handleInput("a");
		editor.handleInput("c");
		editor.handleInput("h");
		editor.handleInput("e");
		editor.handleInput("\r");
		const filtered = stripTerminalSequences(editor.render(80).join("\n"));
		expect(filtered).toContain("/ cache");
		expect(filtered).toContain("Cache diagnostics");
		expect(filtered).not.toContain("Auto compaction");
	});

	test("emits Pi's cursor marker while the filter input is active", () => {
		initializeTui();
		const editor = new SettingsEditor(
			[
				{
					id: "first",
					section: "General",
					label: "Cache diagnostics",
					description: "Show cache status.",
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
		);
		editor.focused = true;

		editor.handleInput("/");
		editor.handleInput("c");
		expect(editor.render(80).join("\n")).toContain(`/ c${CURSOR_MARKER}`);

		editor.handleInput("\r");
		expect(editor.render(80).join("\n")).not.toContain(CURSOR_MARKER);
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

	test("keeps searchable enums and inline string editing", () => {
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

		enumEditor.handleInput("\r");
		enumEditor.handleInput("/");
		enumEditor.handleInput("m");
		enumEditor.handleInput("i");
		enumEditor.handleInput("n");
		enumEditor.handleInput("\r");
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

	test("previews independently combinable activity markers and text shimmer", () => {
		initializeTui();
		const mountsBefore = sharedMotionScheduler.activeMountCount;
		configureTuiAppearance({ shimmer: "glow" });
		const markerEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-libtui.activityMarker",
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
						{ value: "pulse", label: "Pulse", description: "Pulsing marker." },
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
		const lines = markerEditor.render(100).map(stripTerminalSequences);
		expect(lines.find((line) => line.includes("Off"))).not.toContain("● Off");
		expect(lines.find((line) => line.includes("Spinner"))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Spinner/u);
		expect(lines.find((line) => line.includes("Pulse"))).toContain("● Pulse");
		expect(lines.find((line) => line.includes("Static"))).toContain("● Static");
		expect(lines.find((line) => line.includes("Line"))).toMatch(/[-\\|/] Line/u);
		expect(lines.find((line) => line.includes("Arc"))).toMatch(/[◜◠◝◞◡◟] Arc/u);
		expect(lines.find((line) => line.includes("Dots"))).toMatch(/[⠁⠂⠄⡀⢀⠠⠐⠈] Dots/u);
		expect(lines.find((line) => line.includes("Quadrants"))).toMatch(/[▖▘▝▗] Quadrants/u);
		expect(lines.find((line) => line.includes("Sparkle"))).toMatch(/[✦✧] Sparkle/u);
		markerEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		configureTuiAppearance({ activityMarker: "pulse", shimmer: "off" });
		const shimmerEditor = new SettingsEditor(
			[
				{
					id: "extensions.pi-libtui.shimmer",
					section: "UI & Display",
					label: "Text shimmer",
					description: "Choose text motion.",
					type: "enum",
					value: "off",
					defaultValue: "off",
					configured: false,
					options: [
						{ value: "off", label: "Off", description: "Steady text." },
						{ value: "sweep", label: "Sweep", description: "Narrow highlight." },
						{ value: "glow", label: "Glow", description: "Broad highlight." },
						{ value: "rainbow", label: "Rainbow", description: "Color wave." },
						{ value: "rainbow-glow", label: "Rainbow glow", description: "Color glow." },
						{ value: "lightning", label: "Lightning", description: "Fast strike." },
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
		shimmerEditor.handleInput("\r");
		const shimmerLines = shimmerEditor.render(100);
		const strippedShimmerLines = shimmerLines.map(stripTerminalSequences);
		const baseShimmerLines = strippedShimmerLines.map((line) => line.normalize("NFD").replace(/\p{M}/gu, ""));
		for (const label of ["Off", "Sweep", "Glow", "Rainbow", "Rainbow glow", "Lightning"])
			expect(baseShimmerLines.find((line) => line.includes(label))).toContain(`● ${label}`);
		shimmerEditor.handleInput("\x1b");
		expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);

		for (const field of [
			{
				id: "extensions.pi-libtui.animationSpeed",
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
			const timingLines = editor
				.render(100)
				.map(stripTerminalSequences)
				.map((line) => line.normalize("NFD").replace(/\p{M}/gu, ""));
			for (const option of field.options)
				expect(timingLines.find((line) => line.includes(option.label))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u);
			editor.handleInput("\x1b");
			expect(sharedMotionScheduler.activeMountCount).toBe(mountsBefore);
		}
	});

	test("opens editors through the shared dialog host without replacing the settings UI", () => {
		initializeTui();
		const changes: Array<[string, SettingValue]> = [];
		let dialog: Component | undefined;
		let parent: { row: number; col: number } | undefined;
		let dialogTitle: TuiTitleSource | undefined;
		let closed = 0;
		const dialogs: DialogHost = {
			open(component, options) {
				dialog = component;
				parent = options?.parent;
				dialogTitle = options?.title;
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
		expect(stripTerminalSequences(editor.render(80).join("\n"))).not.toContain("Minimal");
		expect(stripTerminalSequences(dialog!.render(50).join("\n"))).toContain("Minimal");
		expect(parent).toEqual({ row: 1, col: 32 });
		expect(dialogTitle).toBe("Mode");
		dialog!.handleInput?.("j");
		dialog!.handleInput?.("\r");

		expect(changes).toEqual([["mode", "minimal"]]);
		expect(closed).toBe(1);
		expect(dialog).toBeUndefined();
	});

	test("uses Tab for sections while h and l remain tab navigation", () => {
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

		editor.handleInput("\t");
		editor.handleInput("\r");
		expect(changes).toEqual([["b", true]]);
		editor.handleInput("\x1b[Z");
		editor.handleInput("\r");
		expect(changes).toEqual([
			["b", true],
			["a", true],
		]);
	});

	test("saves multi-enums on Enter and warns before Escape discards a changed draft", () => {
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
		expect(editor.render(80).join("\n")).toContain("Unsaved changes");
		expect(changes).toEqual([]);
		editor.handleInput("\x1b");
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
		expect(initial).toContain(`${semantic.fgAnsi("text.secondary")}Safe`);
		expect(initial).toContain(`${semantic.fgAnsi("heading")}none`);
		editor.handleInput("j");
		editor.handleInput("\x7f");
		const rendered = editor.render(80).join("\n");
		expect(resets).toEqual(["tools"]);
		expect(rendered).toContain("all default tools");
		expect(rendered).toContain(`${semantic.fgAnsi("text.secondary")}all default tools`);
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
		expect(inline).not.toMatch(/[╭╮╰╯│]/);
		editor.handleInput("j");
		editor.handleInput("\x0b");
		editor.handleInput("\x13");
		expect(changes).toEqual([[{ name: "b" }, { name: "a" }]]);
	});
});
