import { type Component, type Focusable, isFocusable } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "./mouse.ts";

/** Input-routing policy for a {@link ComponentStack}. */
export type ComponentStackInputMode = "active" | "all";

/** Construction options for a vertical component stack. */
export interface ComponentStackOptions {
	/** Send input to one selected child, or to every child in display order. */
	inputMode?: ComponentStackInputMode;
	/** Zero-based initial active child; invalid values select the first child. */
	activeChild?: number;
	/** Fill or clip the rendered stack to this many rows. */
	height?: number | (() => number);
	/** Clip after this many rows without padding shorter content. */
	maxHeight?: number | (() => number);
	/** Place the final child at the bottom when the configured height has spare rows. */
	anchorLastChild?: boolean;
}

/** Geometry recorded for one visible child after the latest render. */
export interface ComponentStackSpan {
	/** Child component occupying this span. */
	readonly component: Component;
	/** Zero-based position of the child in the stack. */
	readonly index: number;
	/** Zero-based first row of the child within the stack. */
	readonly row: number;
	/** Number of visible rows retained after clipping. */
	readonly height: number;
	/** Width in columns supplied to the child during rendering. */
	readonly width: number;
}

type MouseComponent = Component & { onMouse?(event: TuiMouseEvent): boolean };

/**
 * A vertical, semantic component host. Consumers compose and focus children;
 * pointer discovery and coordinate translation remain structural details.
 */
export class ComponentStack implements Component, Focusable {
	private stackChildren: Component[];
	private activeChild: number | undefined;
	private spans: ComponentStackSpan[] = [];
	private renderedHeight = 0;
	private renderedWidth = 0;
	private hoveredSpan: ComponentStackSpan | undefined;
	private capturedSpan: ComponentStackSpan | undefined;
	private _focused = false;

	constructor(
		children: readonly Component[] = [],
		private readonly options: ComponentStackOptions = {},
	) {
		this.stackChildren = [...children];
		this.activeChild = options.activeChild ?? (children.length > 0 ? 0 : undefined);
		this.clampActiveChild();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		const active = this.getActiveChild();
		if (active && isFocusable(active)) active.focused = value;
	}

	setChildren(children: readonly Component[]): void {
		if (
			children.length === this.stackChildren.length &&
			children.every((child, index) => child === this.stackChildren[index])
		)
			return;
		const active = this.activeChild === undefined ? undefined : this.stackChildren[this.activeChild];
		this.stackChildren = [...children];
		this.activeChild = active ? this.stackChildren.indexOf(active) : this.activeChild;
		this.clampActiveChild();
		if (this._focused) {
			if (active && active !== this.getActiveChild() && isFocusable(active)) active.focused = false;
			const next = this.getActiveChild();
			if (next && isFocusable(next)) next.focused = true;
		}
		this.spans = [];
		this.hoveredSpan = undefined;
		this.capturedSpan = undefined;
	}

	setActiveChild(child: number | Component | undefined): void {
		const previous = this.getActiveChild();
		this.activeChild = typeof child === "number" || child === undefined ? child : this.stackChildren.indexOf(child);
		this.clampActiveChild();
		if (this._focused) {
			if (previous && previous !== this.getActiveChild() && isFocusable(previous)) previous.focused = false;
			const next = this.getActiveChild();
			if (next && isFocusable(next)) next.focused = true;
		}
	}

	getActiveChild(): Component | undefined {
		return this.activeChild === undefined ? undefined : this.stackChildren[this.activeChild];
	}

	getChildren(): readonly Component[] {
		return [...this.stackChildren];
	}

	getSpans(): readonly ComponentStackSpan[] {
		return this.spans.map((span) => ({ ...span }));
	}

	handleInput(data: string): void {
		if ((this.options.inputMode ?? "active") === "all") {
			for (const child of this.stackChildren) child.handleInput?.(data);
			return;
		}
		this.getActiveChild()?.handleInput?.(data);
	}

	/** Route viewport input to the active child, preserving boolean handling. */
	handleViewportInput(data: string): boolean {
		const active = this.getActiveChild() as (Component & { handleViewportInput?(data: string): boolean }) | undefined;
		return active?.handleViewportInput?.(data) ?? Boolean(active?.handleInput?.(data));
	}

	invalidate(): void {
		this.spans = [];
		this.hoveredSpan = undefined;
		this.capturedSpan = undefined;
		for (const child of this.stackChildren) child.invalidate();
	}

	render(width: number): string[] {
		this.renderedWidth = Math.max(0, Math.floor(width));
		const configuredHeight = typeof this.options.height === "function" ? this.options.height() : this.options.height;
		const configuredMaxHeight =
			typeof this.options.maxHeight === "function" ? this.options.maxHeight() : this.options.maxHeight;
		const fixedHeight = configuredHeight !== undefined;
		const requestedHeight = configuredHeight ?? configuredMaxHeight;
		const boundedHeight = requestedHeight === undefined ? undefined : Math.max(0, Math.floor(requestedHeight));
		const rendered: Array<string[] | undefined> = new Array(this.stackChildren.length);
		if (boundedHeight === undefined) {
			for (const [index, child] of this.stackChildren.entries()) rendered[index] = child.render(this.renderedWidth);
		}
		const footerIndex = this.options.anchorLastChild && rendered.length > 1 ? rendered.length - 1 : undefined;
		if (boundedHeight !== undefined && boundedHeight > 0 && footerIndex !== undefined)
			rendered[footerIndex] = this.stackChildren[footerIndex]!.render(this.renderedWidth);
		const naturalHeight = rendered.reduce((height, lines) => height + (lines?.length ?? 0), 0);
		const height = boundedHeight ?? naturalHeight;
		const anchoredFooter = footerIndex === undefined ? undefined : rendered[footerIndex];
		const footerRow = anchoredFooter ? Math.max(0, height - Math.min(height, anchoredFooter.length)) : height;
		const lines: string[] = [];
		const spans: ComponentStackSpan[] = [];

		for (const [index, child] of this.stackChildren.entries()) {
			const isFooter = anchoredFooter !== undefined && index === footerIndex;
			if (isFooter && lines.length < footerRow)
				lines.push(...Array.from({ length: footerRow - lines.length }, () => ""));
			const row = lines.length;
			const available = Math.max(0, (isFooter ? height : footerRow) - row);
			if (available === 0 && !isFooter) {
				if (footerIndex !== undefined) continue;
				break;
			}
			const childLines = rendered[index] ?? child.render(this.renderedWidth);
			const visibleLines = childLines.slice(0, available);
			lines.push(...visibleLines);
			if (visibleLines.length > 0) {
				spans.push({
					component: this.stackChildren[index]!,
					index,
					row,
					height: visibleLines.length,
					width: this.renderedWidth,
				});
			}
			if (lines.length >= height) break;
		}
		if (fixedHeight) while (lines.length < height) lines.push("");

		const remap = (previous: ComponentStackSpan | undefined): ComponentStackSpan | undefined =>
			previous
				? spans.find((span) => span.component === previous.component && span.index === previous.index)
				: undefined;
		this.hoveredSpan = remap(this.hoveredSpan);
		this.capturedSpan = remap(this.capturedSpan);
		this.spans = spans;
		this.renderedHeight = lines.length;
		return lines;
	}

	/** Dispatch a normalized pointer event to the child span under its coordinates. */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			const handled = this.hoveredSpan ? this.dispatch(this.hoveredSpan, event) : false;
			this.hoveredSpan = undefined;
			return handled;
		}

		if ((event.type === "drag" || event.type === "release") && this.capturedSpan) {
			const captured = this.capturedSpan;
			const handled = this.dispatch(captured, event);
			if (event.type === "release") this.capturedSpan = undefined;
			return handled;
		}

		const inside =
			event.col >= 0 && event.col < this.renderedWidth && event.row >= 0 && event.row < this.renderedHeight;
		const span = inside
			? this.spans.find((candidate) => event.row >= candidate.row && event.row < candidate.row + candidate.height)
			: undefined;
		const hoverHandled = this.updateHover(span, event);
		if (!span) return hoverHandled;
		const handled = this.dispatch(span, event);
		if (event.type === "press" && handled) this.capturedSpan = span;
		return hoverHandled || handled;
	}

	private updateHover(span: ComponentStackSpan | undefined, event: TuiMouseEvent): boolean {
		if (this.hoveredSpan?.component === span?.component && this.hoveredSpan?.index === span?.index) return false;
		if (this.hoveredSpan) this.dispatch(this.hoveredSpan, { ...event, type: "leave" });
		this.hoveredSpan = span;
		// A press must reach the child before any enter-triggered redraw clears
		// nested stack geometry. All-motion terminals send the regular enter/move
		// transition independently, so clicks do not need to synthesize one.
		return span && (event.type === "enter" || event.type === "move")
			? this.dispatch(span, { ...event, type: "enter" })
			: false;
	}

	private dispatch(span: ComponentStackSpan, event: TuiMouseEvent): boolean {
		const handler = (span.component as MouseComponent).onMouse;
		if (!handler) return false;
		return handler.call(span.component, { ...event, row: event.row - span.row });
	}

	private clampActiveChild(): void {
		if (this.stackChildren.length === 0) {
			this.activeChild = undefined;
			return;
		}
		if (this.activeChild === undefined || this.activeChild < 0 || this.activeChild >= this.stackChildren.length) {
			this.activeChild = 0;
		}
	}
}
