import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "../mouse.ts";

/** State and layout supplied to a selectable-list item renderer. */
export interface SelectableListRenderContext {
	/** Available row width in terminal cells. */
	width: number;
	/** Zero-based item index in the complete list. */
	index: number;
	/** Whether keyboard navigation currently selects this item. */
	selected: boolean;
	/** Whether the pointer currently hovers this item's target. */
	hovered: boolean;
	/** Whether the preceding item is selected, for stable shared boundaries. */
	previousSelected: boolean;
}

/** Interactive terminal-cell geometry for one visible list item. */
export interface SelectableListItemGeometry {
	/** Zero-based target column relative to the list. */
	x: number;
	/** Zero-based target row relative to the list. */
	y: number;
	/** Interactive target width in terminal cells. */
	width: number;
	/** Interactive target height in terminal rows. */
	height: number;
	/** Zero-based index in the complete item list. */
	index: number;
}

/** Geometry for the most recent selectable-list render. */
export interface SelectableListGeometry {
	/** Zero-based list column relative to its owning component. */
	x: number;
	/** Zero-based list row relative to its owning component. */
	y: number;
	/** Rendered list width in terminal cells. */
	width: number;
	/** Rendered list height in terminal rows. */
	height: number;
	/** Index of the first item visible in the current viewport. */
	startIndex: number;
	/** Rendered row offset of the first visible item. */
	startRow: number;
	/** Total rendered rows across every item. */
	totalRows: number;
	/** Interactive geometry for each visible item. */
	items: readonly SelectableListItemGeometry[];
}

/** One semantic selectable row with optional non-selectable layout around it. */
export interface SelectableListRow {
	/** Decorative lines rendered before the selectable row. */
	before?: readonly string[];
	/** Decorative columns rendered before, but excluded from, the selectable row. */
	leading?: string;
	/** Selectable row content rendered after any excluded leading columns. */
	content: string | readonly string[];
	/** Optional pointer target relative to the content rows. Defaults to all content after `leading`. */
	target?: { x: number; y: number; width: number; height: number };
}

/** Construction options for {@link SelectableList}. */
export interface SelectableListOptions<Item> {
	/** Complete ordered item list. */
	items: readonly Item[];
	/** Initially selected index; clamped to the available items. */
	selectedIndex?: number;
	/** Maximum rendered lines. One oversized item may exceed this so it remains a complete target. */
	maxVisible?: number;
	/** Keyboard navigation wraps by default. */
	wrap?: boolean;
	/** Pointer release activates by default. Disable when click should only select. */
	activateOnClick?: boolean;
	/** Render one semantic item and identify any decorative layout around it. */
	renderItem(item: Item, context: SelectableListRenderContext): string | string[] | SelectableListRow;
	/** Request a host render after interaction or synchronized state changes. */
	requestRender(): void;
	/** Receive selection changes caused by keyboard or pointer input. */
	onSelectionChange?(item: Item, index: number): void;
	/** Receive item activation from confirmation or pointer release. */
	onActivate(item: Item, index: number): void;
}

/** A domain-free list with semantic selection and activation. */
export class SelectableList<Item> implements Component {
	private items: readonly Item[];
	private selectedIndex: number;
	private maxVisible: number | undefined;
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;
	private viewportStart = 0;
	private followSelection = true;
	private geometry: SelectableListGeometry | undefined;

	/**
	 * Create a selectable list.
	 * @param config Items, rendering policy, interaction callbacks, and viewport bounds.
	 */
	constructor(private readonly config: SelectableListOptions<Item>) {
		this.items = config.items;
		this.selectedIndex = clampIndex(config.selectedIndex ?? 0, this.items.length);
		this.maxVisible = config.maxVisible;
	}

	/**
	 * Handle navigation and activation keybindings.
	 * @param data Raw terminal input from Pi.
	 * @returns True when the list consumes the input.
	 */
	handleInput(data: string): boolean {
		const keybindings = getKeybindings();
		if (data === "j" || keybindings.matches(data, "tui.select.down")) {
			this.move(1, this.config.wrap !== false);
			return true;
		}
		if (data === "k" || keybindings.matches(data, "tui.select.up")) {
			this.move(-1, this.config.wrap !== false);
			return true;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.activate(this.selectedIndex);
			return true;
		}
		return false;
	}

	/**
	 * Handle pointer input when the shared component host routes it to this list.
	 * @param event Component-local pointer event.
	 * @returns True when the event targets an item or performs wheel navigation.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			const changed = this.hoverIndex !== undefined || this.pressedIndex !== undefined;
			this.hoverIndex = undefined;
			this.pressedIndex = undefined;
			if (changed) this.config.requestRender();
			return false;
		}

		const geometry = this.geometry;
		if (!geometry) return false;
		const inside = event.col >= 0 && event.col < geometry.width && event.row >= 0 && event.row < geometry.height;
		if (!inside) {
			this.updateHover(undefined);
			if (event.type === "release") this.pressedIndex = undefined;
			return false;
		}

		const item = geometry.items.find(
			(candidate) =>
				event.col >= candidate.x &&
				event.col < candidate.x + candidate.width &&
				event.row >= candidate.y &&
				event.row < candidate.y + candidate.height,
		);
		this.updateHover(item?.index);
		if (event.type === "wheel" && event.wheel !== undefined) {
			this.scrollViewport(event.wheel);
			return true;
		}
		if (event.type === "press" && event.button === 0) {
			this.pressedIndex = item?.index;
			if (item) this.select(item.index, true);
		} else if (event.type === "release" && event.button === 0) {
			const pressed = this.pressedIndex;
			this.pressedIndex = undefined;
			if (item && pressed === item.index && this.config.activateOnClick !== false) this.activate(item.index);
		}
		return item !== undefined;
	}

	/**
	 * Replace list contents and optionally synchronize selection without firing a callback.
	 * @param items New complete ordered item list.
	 * @param selectedIndex Selected index for the new list; defaults to the current index.
	 */
	setItems(items: readonly Item[], selectedIndex = this.selectedIndex): void {
		this.items = items;
		this.selectedIndex = clampIndex(selectedIndex, items.length);
		this.hoverIndex = undefined;
		this.pressedIndex = undefined;
		this.viewportStart = Math.min(this.viewportStart, Math.max(0, items.length - 1));
		this.followSelection = true;
		this.geometry = undefined;
		this.config.requestRender();
	}

	/**
	 * Synchronize external selection without firing a selection callback.
	 * @param index New selected index, clamped to the available items.
	 */
	setSelectedIndex(index: number): void {
		const next = clampIndex(index, this.items.length);
		const changed = next !== this.selectedIndex || !this.followSelection;
		this.selectedIndex = next;
		this.followSelection = true;
		if (changed) this.config.requestRender();
	}

	/**
	 * Update the rendered line budget when a parent layout gains or loses fixed rows.
	 * @param maxVisible Maximum rendered lines, or undefined for no explicit budget.
	 */
	setMaxVisible(maxVisible: number | undefined): void {
		if (this.maxVisible === maxVisible) return;
		this.maxVisible = maxVisible;
		this.geometry = undefined;
		this.config.requestRender();
	}

	/** @returns The current selected index, or -1 when the list is empty. */
	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	/** @returns The selected item, or undefined when the list is empty. */
	getSelectedItem(): Item | undefined {
		return this.items[this.selectedIndex];
	}

	/** @returns A defensive copy of the latest list geometry, if rendered. */
	getGeometry(): SelectableListGeometry | undefined {
		if (!this.geometry) return undefined;
		return {
			...this.geometry,
			items: this.geometry.items.map((item) => ({ ...item })),
		};
	}

	/** Clear cached interactive geometry after external state changes. */
	invalidate(): void {
		this.geometry = undefined;
	}

	/**
	 * Render the bounded viewport and update interactive item geometry.
	 * @param width Available width in terminal cells.
	 * @returns Visible item rows, or no rows for an empty or zero-width list.
	 */
	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0 || this.items.length === 0) {
			this.geometry = {
				x: 0,
				y: 0,
				width: boundedWidth,
				height: 0,
				startIndex: 0,
				startRow: 0,
				totalRows: 0,
				items: [],
			};
			return [];
		}

		this.selectedIndex = clampIndex(this.selectedIndex, this.items.length);
		const rendered = this.items.map((item, index) =>
			normalizeItem(
				this.config.renderItem(item, {
					width: boundedWidth,
					index,
					selected: index === this.selectedIndex,
					hovered: index === this.hoverIndex,
					previousSelected: index > 0 && index - 1 === this.selectedIndex,
				}),
				boundedWidth,
			),
		);
		const budget = Math.max(1, Math.floor(this.maxVisible ?? Number.POSITIVE_INFINITY));
		const { start, end } = visibleRange(
			rendered.map((item) => item.lines),
			this.selectedIndex,
			this.viewportStart,
			budget,
			this.followSelection,
		);
		this.viewportStart = start;

		const lines: string[] = [];
		const items: SelectableListItemGeometry[] = [];
		for (let index = start; index < end; index += 1) {
			const renderedItem = rendered[index]!;
			const y = lines.length;
			lines.push(...renderedItem.lines);
			items.push({
				x: renderedItem.target.x,
				y: y + renderedItem.target.y,
				width: renderedItem.target.width,
				height: renderedItem.target.height,
				index,
			});
		}
		this.geometry = {
			x: 0,
			y: 0,
			width: boundedWidth,
			height: lines.length,
			startIndex: start,
			startRow: rendered.slice(0, start).reduce((height, item) => height + item.lines.length, 0),
			totalRows: rendered.reduce((height, item) => height + item.lines.length, 0),
			items,
		};
		return lines;
	}

	private move(delta: number, wrap: boolean): void {
		if (this.items.length === 0) return;
		let next = this.selectedIndex + delta;
		if (wrap) next = (next + this.items.length) % this.items.length;
		this.select(clampIndex(next, this.items.length), true);
	}

	private scrollViewport(delta: number): void {
		if (this.items.length === 0 || delta === 0) return;
		this.viewportStart = Math.max(0, Math.min(this.viewportStart + delta, this.items.length - 1));
		this.followSelection = false;
		this.hoverIndex = undefined;
		this.pressedIndex = undefined;
		this.geometry = undefined;
		this.config.requestRender();
	}

	private select(index: number, notify: boolean): void {
		if (index < 0) return;
		const changed = index !== this.selectedIndex || !this.followSelection;
		this.followSelection = true;
		if (!changed) return;
		if (index === this.selectedIndex) {
			this.config.requestRender();
			return;
		}
		this.selectedIndex = index;
		if (notify) {
			this.config.onSelectionChange?.(this.items[index]!, index);
		}
		this.config.requestRender();
	}

	private activate(index: number): void {
		if (index >= 0 && index < this.items.length) this.config.onActivate(this.items[index]!, index);
	}

	private updateHover(index: number | undefined): void {
		if (this.hoverIndex === index) return;
		this.hoverIndex = index;
		this.config.requestRender();
	}
}

function clampIndex(index: number, length: number): number {
	if (length === 0) return -1;
	const finiteIndex = Number.isFinite(index) ? Math.floor(index) : 0;
	return Math.max(0, Math.min(finiteIndex, length - 1));
}

interface NormalizedItem {
	lines: string[];
	target: { x: number; y: number; width: number; height: number };
}

function normalizeItem(rendered: string | string[] | SelectableListRow, width: number): NormalizedItem {
	if (typeof rendered === "string" || Array.isArray(rendered)) {
		const lines = (typeof rendered === "string" ? [rendered] : rendered.length > 0 ? [...rendered] : [""]).map((line) =>
			truncateToWidth(line, width, ""),
		);
		return { lines, target: { x: 0, y: 0, width, height: lines.length } };
	}
	const before = (rendered.before ?? []).map((line) => truncateToWidth(line, width, ""));
	const leading = truncateToWidth(rendered.leading ?? "", width, "");
	const x = visibleWidth(leading);
	const content = typeof rendered.content === "string" ? [rendered.content] : rendered.content;
	const rows = (content.length > 0 ? content : [""]).map((line) => truncateToWidth(`${leading}${line}`, width, ""));
	const requested = rendered.target;
	const targetX = requested ? Math.max(0, Math.min(width, Math.floor(requested.x))) : x;
	const targetY = requested ? Math.max(0, Math.min(rows.length, Math.floor(requested.y))) : 0;
	const targetWidth = requested
		? Math.max(0, Math.min(width - targetX, Math.floor(requested.width)))
		: Math.max(0, width - x);
	const targetHeight = requested
		? Math.max(0, Math.min(rows.length - targetY, Math.floor(requested.height)))
		: rows.length;
	return {
		lines: [...before, ...rows],
		target: { x: targetX, y: before.length + targetY, width: targetWidth, height: targetHeight },
	};
}

function visibleRange(
	rendered: readonly string[][],
	selected: number,
	preferredStart: number,
	budget: number,
	followSelection: boolean,
): { start: number; end: number } {
	let start = Math.max(0, Math.min(preferredStart, rendered.length - 1));
	if (!followSelection) {
		let end = fitEnd(rendered, start, budget);
		let used = rendered.slice(start, end).reduce((height, lines) => height + lines.length, 0);
		while (start > 0 && used + rendered[start - 1]!.length <= budget) {
			start -= 1;
			used += rendered[start]!.length;
		}
		end = fitEnd(rendered, start, budget);
		return { start, end };
	}
	if (selected < start) start = selected;
	let end = fitEnd(rendered, start, budget);
	if (selected < end) return { start, end };

	start = selected;
	let used = rendered[selected]?.length ?? 0;
	while (start > 0 && used + rendered[start - 1]!.length <= budget) {
		start -= 1;
		used += rendered[start]!.length;
	}
	end = fitEnd(rendered, start, budget);
	return { start, end: Math.max(end, selected + 1) };
}

function fitEnd(rendered: readonly string[][], start: number, budget: number): number {
	let end = start;
	let used = 0;
	while (end < rendered.length) {
		const height = rendered[end]!.length;
		if (end > start && used + height > budget) break;
		used += height;
		end += 1;
	}
	return end;
}
