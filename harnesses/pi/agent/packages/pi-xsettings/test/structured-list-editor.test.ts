import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ListDefinition, SettingValue } from "../src/protocol/settings.ts";
import { StructuredListEditor } from "../src/ui/structured-list-editor.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
} as Theme;

const candidates: ListDefinition = {
	itemLabel: "Candidate",
	identity: "model",
	uniqueIdentity: false,
	summary: [{ path: ["thinking"], colors: { low: { hue: "cyan", shade: 2 }, high: { hue: "blue", shade: 4 } } }],
	minItems: 1,
	newItem: { model: "provider/new", thinking: "low" },
	fields: [
		{
			key: "model",
			label: "Model",
			description: "Candidate model.",
			shortcut: "m",
			type: "enum",
			options: { source: "models" },
		},
		{
			key: "thinking",
			label: "Thinking",
			description: "Reasoning effort.",
			shortcut: "t",
			type: "enum",
			options: [
				{ value: "low", label: "Low", description: "", color: { hue: "cyan", shade: 2 } },
				{ value: "high", label: "High", description: "", color: { hue: "blue", shade: 4 } },
			],
		},
	],
};

const roles: ListDefinition = {
	itemLabel: "Role",
	identity: "name",
	uniqueIdentity: true,
	identityColor: { path: ["color"], colors: { success: "positive", warning: "warning" } },
	summary: [{ path: ["candidates", 0, "model"], color: "text.muted" }],
	minItems: 1,
	newItem: { name: "role", color: "warning", candidates: [candidates.newItem] },
	fields: [
		{ key: "name", label: "Name", description: "Role name.", type: "string" },
		{
			key: "color",
			label: "Color",
			description: "Role color.",
			shortcut: "c",
			type: "enum",
			options: [
				{ value: "success", label: "Success", description: "", color: "positive" },
				{ value: "warning", label: "Warning", description: "", color: "warning" },
			],
		},
		{
			key: "candidates",
			label: "Candidates",
			description: "Ordered fallbacks.",
			shortcut: "m",
			type: "list",
			list: candidates,
		},
	],
};

const schema = Type.Array(
	Type.Object({
		name: Type.String(),
		color: Type.Union([Type.Literal("success"), Type.Literal("warning")]),
		candidates: Type.Array(
			Type.Object({
				model: Type.String(),
				thinking: Type.Union([Type.Literal("low"), Type.Literal("high")]),
			}),
			{ minItems: 1 },
		),
	}),
	{ minItems: 1 },
);

function create(onSave: (value: SettingValue[]) => void, onCancel: () => void = () => {}): StructuredListEditor {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	return new StructuredListEditor({
		label: "Roles",
		description: "Ordered roles.",
		value: [{ name: "balanced", color: "success", candidates: [{ model: "provider/current", thinking: "high" }] }],
		schema,
		list: roles,
		modelOptions: [
			{ value: "provider/current", label: "Current", description: "" },
			{ value: "provider/next", label: "Next", description: "" },
		],
		theme,
		onSave,
		onCancel,
	});
}

function pointer(
	editor: StructuredListEditor,
	type: "move" | "press" | "release" | "wheel",
	row: number,
	col: number,
	wheel?: number,
): boolean {
	const handler = Reflect.get(editor, "onMouse");
	if (typeof handler !== "function") throw new Error("Expected inherited pointer dispatch.");
	return (
		Reflect.apply(handler, editor, [
			{
				type,
				row,
				col,
				screenRow: row,
				screenCol: col,
				button: type === "press" || type === "release" ? 0 : undefined,
				wheel,
				shift: false,
				alt: false,
				ctrl: false,
			},
		]) === true
	);
}

function clickText(editor: StructuredListEditor, text: string, width = 120): void {
	const lines = editor.render(width).map(stripTerminalSequences);
	let row = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index]!.includes(text)) {
			row = index;
			break;
		}
	}
	if (row < 0) throw new Error(`Could not find ${text}.`);
	const col = lines[row]!.indexOf(text) + Math.floor(text.length / 2);
	pointer(editor, "press", row, col);
	pointer(editor, "release", row, col);
}

test("nested list fields use the same inline settings controls", () => {
	const editor = create(() => {});
	editor.handleInput("m");
	editor.handleInput("m");

	const rendered = stripTerminalSequences(editor.render(80).join("\n"));
	expect(rendered).toContain("Candidate model.");
	expect(rendered).toContain("Current");
	expect(rendered).toContain("Next");
	expect(rendered).not.toMatch(/[╭╮╰╯│]/);
});

test("declarative colors and shortcuts keep rich nested settings easy to edit", () => {
	const styledTheme = {
		bold: (text: string) => `<bold>${text}</bold>`,
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as Theme;
	const editor = new StructuredListEditor({
		label: "Roles",
		description: "Ordered roles.",
		value: [{ name: "balanced", color: "success", candidates: [{ model: "provider/current", thinking: "high" }] }],
		schema,
		list: roles,
		modelOptions: [
			{ value: "provider/current", label: "Current", description: "" },
			{ value: "provider/next", label: "Next", description: "" },
		],
		theme: styledTheme,
		onSave() {},
		onCancel() {},
	});

	const roleList = editor.render(200).join("\n");
	expect(roleList).toContain("<bold>balanced</bold>");
	expect(roleList).toContain("provider/current");
	expect(roleList).toContain("c color · m candidates");

	editor.handleInput("c");
	expect(editor.render(200).join("\n")).toContain("Success");

	const candidateEditor = new StructuredListEditor({
		label: "Roles",
		description: "Ordered roles.",
		value: [{ name: "balanced", color: "success", candidates: [{ model: "provider/current", thinking: "high" }] }],
		schema,
		list: roles,
		modelOptions: [
			{ value: "provider/current", label: "Current", description: "" },
			{ value: "provider/next", label: "Next", description: "" },
		],
		theme: styledTheme,
		onSave() {},
		onCancel() {},
	});
	candidateEditor.handleInput("m");
	expect(candidateEditor.render(200).join("\n")).toContain("m model · t thinking");
	candidateEditor.handleInput("t");
	expect(stripTerminalSequences(candidateEditor.render(200).join("\n"))).toContain("High");
});

test("saves nested additions as one structured value", () => {
	const saved: SettingValue[][] = [];
	const editor = create((value) => saved.push(value));
	editor.handleInput("m");
	editor.handleInput("a");
	editor.handleInput("\x13");

	expect(saved).toEqual([
		[
			{
				name: "balanced",
				color: "success",
				candidates: [
					{ model: "provider/current", thinking: "high" },
					{ model: "provider/new", thinking: "low" },
				],
			},
		],
	]);
});

test("shared lists and action bars keep viewport scrolling separate from keyboard selection", () => {
	const saved: SettingValue[][] = [];
	let cancels = 0;
	const editor = create(
		(value) => saved.push(value),
		() => {
			cancels += 1;
		},
	);

	const root = editor.render(120).map(stripTerminalSequences);
	expect(root.join("\n")).toContain(" Add ");
	expect(root.join("\n")).toContain(" Delete ");
	expect(root.join("\n")).toContain(" Move Up ");
	expect(root.join("\n")).toContain(" Move Down ");
	expect(root.join("\n")).toContain(" Save ");
	expect(root.join("\n")).toContain(" Cancel ");

	clickText(editor, " Add ");
	expect(stripTerminalSequences(editor.render(120).join("\n"))).toContain("Role: role");
	clickText(editor, " Back ");

	const listLines = editor.render(120).map(stripTerminalSequences);
	const firstRow = listLines.findIndex((line) => line.includes("balanced"));
	expect(firstRow).toBeGreaterThanOrEqual(0);
	expect(pointer(editor, "wheel", firstRow, 1, -1)).toBe(true);
	editor.handleInput("k");
	editor.handleInput("\r");
	expect(stripTerminalSequences(editor.render(120).join("\n"))).toContain("Role: balanced");

	clickText(editor, "Name");
	expect(stripTerminalSequences(editor.render(120).join("\n"))).toContain("Enter save");
	clickText(editor, " Save ");
	clickText(editor, "Color");
	expect(stripTerminalSequences(editor.render(120).join("\n"))).toContain("Success");
	editor.handleInput("\x1b");
	clickText(editor, " Back ");

	clickText(editor, " Move Down ");
	clickText(editor, " Save ");
	expect(saved.at(-1)?.map((value) => (value as { name: string }).name)).toEqual(["role", "balanced"]);
	clickText(editor, " Delete ");
	expect(stripTerminalSequences(editor.render(120).join("\n"))).not.toContain("balanced");
	clickText(editor, " Cancel ");
	clickText(editor, " Cancel ");
	expect(cancels).toBe(1);
});
