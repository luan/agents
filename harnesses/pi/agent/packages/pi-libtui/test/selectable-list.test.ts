import { beforeEach, describe, expect, test } from "bun:test";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { SelectableList } from "../src/controls/selectable-list.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";

function event(overrides: Partial<TuiMouseEvent>): TuiMouseEvent {
	return {
		type: "move",
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

describe("SelectableList", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	test("renders multi-line items as complete targets with exact visible geometry", () => {
		const list = new SelectableList({
			items: ["Alpha", "Beta", "Gamma"],
			selectedIndex: 1,
			maxVisible: 3,
			renderItem: (item, context) =>
				context.index === 1 ? [`heading:${context.width}`, `${context.selected ? ">" : " "}${item}`] : item,
			requestRender() {},
			onActivate() {},
		});

		expect(list.render(24)).toEqual(["Alpha", "heading:24", ">Beta"]);
		expect(list.getGeometry()).toEqual({
			x: 0,
			y: 0,
			width: 24,
			height: 3,
			startIndex: 0,
			items: [
				{ x: 0, y: 0, width: 24, height: 1, index: 0 },
				{ x: 0, y: 1, width: 24, height: 2, index: 1 },
			],
		});
	});

	test("bounds rendered lines to the available width", () => {
		const list = new SelectableList({
			items: ["long"],
			renderItem: () => ["123456", "abcdef"],
			requestRender() {},
			onActivate() {},
		});

		expect(list.render(3).map(stripTerminalSequences)).toEqual(["123", "abc"]);
	});

	test("keyboard wraps selection and confirms the selected item", () => {
		const changes: Array<[string, number]> = [];
		const activations: Array<[string, number]> = [];
		let renders = 0;
		const list = new SelectableList({
			items: ["Alpha", "Beta", "Gamma"],
			renderItem: (item) => item,
			requestRender: () => {
				renders += 1;
			},
			onSelectionChange: (item, index) => changes.push([item, index]),
			onActivate: (item, index) => activations.push([item, index]),
		});

		list.handleInput("k");
		list.handleInput("\r");
		list.handleInput("j");
		expect(changes).toEqual([
			["Gamma", 2],
			["Alpha", 0],
		]);
		expect(activations).toEqual([["Gamma", 2]]);
		expect(renders).toBe(2);
	});

	test("hover and primary click use the full rendered item height", () => {
		const contexts: Array<{ index: number; hovered: boolean; selected: boolean }> = [];
		const activations: string[] = [];
		const changes: string[] = [];
		const list = new SelectableList({
			items: ["Alpha", "Beta"],
			renderItem: (item, context) => {
				contexts.push({ index: context.index, hovered: context.hovered, selected: context.selected });
				return item === "Alpha" ? ["Section", item] : item;
			},
			requestRender() {},
			onSelectionChange: (item) => changes.push(item),
			onActivate: (item) => activations.push(item),
		});

		list.render(20);
		expect(list.onMouse(event({ type: "move", row: 1, col: 4 }))).toBe(true);
		list.render(20);
		expect(contexts.some((context) => context.index === 0 && context.hovered)).toBe(true);
		expect(list.onMouse(event({ type: "press", row: 2, col: 4, button: 0 }))).toBe(true);
		list.render(20);
		expect(list.onMouse(event({ type: "release", row: 2, col: 4, button: 0 }))).toBe(true);
		expect(changes).toEqual(["Beta"]);
		expect(activations).toEqual(["Beta"]);
	});

	test("can make pointer clicks select-only while Enter still activates", () => {
		const changes: string[] = [];
		const activations: string[] = [];
		const list = new SelectableList({
			items: ["Alpha", "Beta"],
			activateOnClick: false,
			renderItem: (item) => item,
			requestRender() {},
			onSelectionChange: (item) => changes.push(item),
			onActivate: (item) => activations.push(item),
		});

		list.render(20);
		list.onMouse(event({ type: "press", row: 1, col: 4, button: 0 }));
		list.onMouse(event({ type: "release", row: 1, col: 4, button: 0 }));
		expect(changes).toEqual(["Beta"]);
		expect(activations).toEqual([]);
		list.handleInput("\r");
		expect(activations).toEqual(["Beta"]);
	});

	test("excludes decorative lines and leading columns from a semantic row target", () => {
		const activations: string[] = [];
		const list = new SelectableList({
			items: ["Terminal images"],
			renderItem: (item) => ({
				before: ["Terminal & Images | Terminal & Images"],
				leading: "                    | ",
				content: item,
			}),
			requestRender() {},
			onActivate: (item) => activations.push(item),
		});

		expect(list.render(60)).toEqual(["Terminal & Images | Terminal & Images", "                    | Terminal images"]);
		expect(list.getGeometry()?.items).toEqual([{ x: 22, y: 1, width: 38, height: 1, index: 0 }]);
		expect(list.onMouse(event({ type: "move", row: 0, col: 2 }))).toBe(false);
		expect(list.onMouse(event({ type: "press", row: 1, col: 2, button: 0 }))).toBe(false);
		list.onMouse(event({ type: "press", row: 1, col: 24, button: 0 }));
		list.onMouse(event({ type: "release", row: 1, col: 24, button: 0 }));
		expect(activations).toEqual(["Terminal images"]);
	});

	test("wheel scrolls the line-budget viewport without changing selection", () => {
		const changes: number[] = [];
		const list = new SelectableList({
			items: ["A", "B", "C", "D"],
			maxVisible: 2,
			renderItem: (item) => item,
			requestRender() {},
			onSelectionChange: (_item, index) => changes.push(index),
			onActivate() {},
		});

		list.render(10);
		list.onMouse(event({ type: "wheel", row: 0, col: 0, wheel: 1 }));
		expect(list.render(10)).toEqual(["B", "C"]);
		expect(list.getGeometry()?.startIndex).toBe(1);
		list.onMouse(event({ type: "wheel", row: 1, col: 0, wheel: 1 }));
		expect(list.render(10)).toEqual(["C", "D"]);
		expect(list.getSelectedIndex()).toBe(0);
		expect(changes).toEqual([]);

		list.handleInput("j");
		expect(list.render(10)).toEqual(["B", "C"]);
		expect(list.getSelectedIndex()).toBe(1);
		expect(changes).toEqual([1]);
	});

	test("external item and selection synchronization is silent", () => {
		const changes: string[] = [];
		let renders = 0;
		const list = new SelectableList({
			items: ["A", "B", "C"],
			renderItem: (item) => item,
			requestRender: () => {
				renders += 1;
			},
			onSelectionChange: (item) => changes.push(item),
			onActivate() {},
		});

		list.setSelectedIndex(2);
		list.setItems(["X", "Y"], 1);
		expect(list.getSelectedIndex()).toBe(1);
		expect(list.getSelectedItem()).toBe("Y");
		expect(changes).toEqual([]);
		expect(renders).toBe(2);
	});

	test("updates its line budget for responsive parent layouts", () => {
		const list = new SelectableList({
			items: ["A", "B", "C"],
			maxVisible: 3,
			renderItem: (item) => item,
			requestRender() {},
			onActivate() {},
		});

		expect(list.render(10)).toEqual(["A", "B", "C"]);
		list.setMaxVisible(2);
		expect(list.render(10)).toEqual(["A", "B"]);
	});
});
