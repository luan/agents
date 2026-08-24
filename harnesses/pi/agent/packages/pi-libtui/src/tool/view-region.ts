import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundSurface, TOOL_SURFACE_BACKGROUND } from "../background-surface.ts";
import { tuiTheme } from "../color/theme.ts";
import { sanitizeTuiField } from "../content/terminal-text.ts";
import { icon } from "../decoration/glyphs.ts";
import {
	clearFoldingCurrent,
	ensureFoldingRegistry,
	FOLD_TARGET_AT_ROW,
	type FoldTarget,
	type FoldTargetAtRow,
} from "../folding.ts";
import {
	preserveViewportOnResize,
	TEXT_INTERACTION_TARGET,
	type TextInteractionTarget,
	type TuiMouseEvent,
} from "../mouse.ts";
import { ExpandedRegionViewport } from "./expanded-region-viewport.ts";

/** Append the local open/closed disclosure glyph without changing row grammar. */
export function appendFoldingChevron(line: string, width: number, theme: Theme, open: boolean): string {
	const boundedWidth = Math.max(0, Math.floor(width));
	if (boundedWidth === 0) return "";
	const glyph = tuiTheme(theme).fg("text.muted", ` ${icon(open ? "fold-open" : "fold-closed")}`);
	const glyphWidth = visibleWidth(glyph);
	if (glyphWidth >= boundedWidth) return truncateToWidth(glyph, boundedWidth, "…");
	const available = boundedWidth - glyphWidth;
	const compact = line.replace(/\s+$/u, "");
	const fitted = visibleWidth(compact) <= available ? compact : truncateToWidth(compact, available, "…");
	return `${fitted}${glyph}`;
}

export interface ToolViewMode {
	id: string;
	component: Component;
	/** Short affordance shown after this mode, for example "12 more lines". */
	nextHint?: string;
	/** Explicit activation target. Defaults to the following mode. */
	activate?: string;
	/** Make one exact rendered row the activation target instead of appending a control. */
	activationRow?: number | "last" | "omission";
}

/** Component-owned omission row exposed after the component has rendered. */
export interface OmissionRowProvider {
	getOmissionRow(): number | undefined;
	/** Update the renderer-owned omission row's semantic hover state. */
	setOmissionRowHovered?(hovered: boolean): void;
}

export interface ToolViewRegionOptions {
	theme: Theme;
	modes: readonly ToolViewMode[];
	initialMode?: string;
	requestRender(): void;
	onModeChange?(mode: string): void;
	onInput?(data: string, mode: string): boolean;
	/** Dispose mode components removed by streaming updates. Defaults to true. */
	disposeReplacedModes?: boolean;
	/** Maximum rendered rows for an expanded payload viewport. */
	maxHeight?: number;
	/** Let the default viewport grow to fit an unusually tall collapsed preview. */
	allowExpandedGrowth?: boolean;
}

type InteractionTarget = "body" | "header";
type PressedInteraction = { target: InteractionTarget; button: 0 | 1 | 2 };

/**
 * Owns one payload's modes, fold state, pointer state, and bounded expanded viewport.
 *
 * The action header delegates to this object through `onHeaderMouse` and
 * `handleHeaderInput`; it does not maintain a second disclosure state machine.
 */
export class ToolViewRegion implements Component, TextInteractionTarget, FoldTarget, FoldTargetAtRow {
	readonly [TEXT_INTERACTION_TARGET] = true as const;
	private modes: readonly ToolViewMode[];
	private modeIndex: number;
	private hoveredTarget: InteractionTarget | undefined;
	private focused = false;
	private pressed: PressedInteraction | undefined;
	private hintGeometry: Array<{ row: number; width: number }> = [];
	private sourceHintGeometry: Array<{ row: number; width: number }> = [];
	private renderedWidth = 0;
	private renderedHeight = 0;
	private readonly expandedViewport: ExpandedRegionViewport;
	private readonly expandedSurface: BackgroundSurface;
	private removeFoldingTarget: (() => void) | undefined;
	private rendered = false;
	private disposed = false;

	constructor(private readonly options: ToolViewRegionOptions) {
		if (options.modes.length === 0) throw new Error("ToolViewRegion requires at least one mode");
		this.modes = options.modes;
		const requested = options.initialMode ? options.modes.findIndex((mode) => mode.id === options.initialMode) : 0;
		this.modeIndex = requested >= 0 ? requested : 0;
		this.expandedViewport = new ExpandedRegionViewport(
			(width) => this.renderMode(width),
			options.maxHeight ?? 20,
			options.allowExpandedGrowth === true,
			options.theme,
			options.requestRender,
		);
		this.expandedSurface = new BackgroundSurface({
			theme: options.theme,
			background: TOOL_SURFACE_BACKGROUND,
			component: this.expandedViewport,
		});
	}

	/** Replace streamed mode contents without replacing this interaction target. */
	updateModes(modes: readonly ToolViewMode[], requestedMode?: string): void {
		if (modes.length === 0) throw new Error("ToolViewRegion requires at least one mode");
		const previousMode = this.getMode();
		const previousComponent = this.mode().component as Component & { setViewportFocus?(focused: boolean): void };
		const headerHovered = this.hoveredTarget === "header";
		this.setOmissionRowHovered(false);
		if (this.options.disposeReplacedModes !== false) disposeRemovedModes(this.modes, modes);
		this.modes = modes;
		const wanted = requestedMode ?? previousMode;
		const requested = modes.findIndex((mode) => mode.id === wanted);
		this.modeIndex = requested >= 0 ? requested : 0;
		this.hoveredTarget = headerHovered && modes.length > 1 ? "header" : undefined;
		if (this.mode().component !== previousComponent) {
			this.pressed = undefined;
			if (this.focused) previousComponent.setViewportFocus?.(false);
		}
		this.hintGeometry = [];
		this.sourceHintGeometry = [];
		if (this.focused) {
			(this.mode().component as Component & { setViewportFocus?(focused: boolean): void }).setViewportFocus?.(true);
		}
		this.expandedViewport.invalidate();
		this.syncFoldingTarget();
	}

	getMode(): string {
		return this.mode().id;
	}

	canExpand(): boolean {
		return this.modes.length > 1;
	}

	isExpanded(): boolean {
		return this.modeIndex !== 0;
	}

	isFolded(): boolean {
		return !this.isExpanded();
	}

	/** Whether the collapsed mode already exposes its own primary control. */
	hasCollapsedPrimaryTarget(): boolean {
		const mode = this.mode();
		return mode.activationRow !== undefined || mode.nextHint !== undefined;
	}

	[FOLD_TARGET_AT_ROW](_row: number): FoldTarget | undefined {
		return this.canExpand() ? this : undefined;
	}

	open(): void {
		if (this.canExpand() && this.isFolded()) this.activate();
	}

	/** Keep the default expanded viewport at least as tall as the rendered preview. */
	ensureExpandedHeight(rows: number): void {
		this.expandedViewport.ensureMinimumHeight(rows);
	}

	close(): void {
		this.collapse();
	}

	setMode(id: string): void {
		const index = this.modes.findIndex((mode) => mode.id === id);
		if (index < 0 || index === this.modeIndex) return;
		this.setOmissionRowHovered(false);
		const previous = this.mode().component as Component & { setViewportFocus?(focused: boolean): void };
		if (this.focused) previous.setViewportFocus?.(false);
		preserveViewportOnResize();
		this.modeIndex = index;
		if (this.focused)
			(this.mode().component as Component & { setViewportFocus?(focused: boolean): void }).setViewportFocus?.(true);
		this.expandedViewport.invalidate();
		this.expandedViewport.scrollToStart();
		this.hintGeometry = [];
		this.sourceHintGeometry = [];
		this.hoveredTarget = undefined;
		this.pressed = undefined;
		this.options.onModeChange?.(id);
		this.options.requestRender();
	}

	/** Toggle between the collapsed mode and the current mode's activation target. */
	toggle(): void {
		if (this.modeIndex === 0) this.activate();
		else this.collapse();
	}

	/** Activate the current mode's explicit target, or advance once. */
	activate(): void {
		const target = this.mode().activate;
		if (target) this.setMode(target);
		else this.advance(1);
	}

	/** Return to the first, collapsed mode. */
	collapse(): void {
		if (this.modeIndex !== 0) this.setMode(this.modes[0]!.id);
	}

	setViewportFocus(focused: boolean): void {
		if (this.focused === focused) {
			(this.mode().component as Component & { setViewportFocus?(focused: boolean): void }).setViewportFocus?.(focused);
			return;
		}
		this.focused = focused;
		if (focused && this.canExpand()) ensureFoldingRegistry().setCurrent(this);
		else clearFoldingCurrent(this);
		(this.mode().component as Component & { setViewportFocus?(focused: boolean): void }).setViewportFocus?.(focused);
		this.options.requestRender();
	}

	isViewportFocused(): boolean {
		return this.focused;
	}

	handleViewportInput(data: string): boolean {
		if (this.focused && this.canExpand()) ensureFoldingRegistry().setCurrent(this);
		const child = this.mode().component as Component & {
			setViewportFocus?(focused: boolean): void;
			handleViewportInput?(data: string): boolean;
			handleInput?(data: string): boolean;
		};
		if (child.handleViewportInput?.(data) ?? child.handleInput?.(data) ?? false) {
			this.expandedViewport.invalidate();
			return true;
		}
		if (this.options.onInput?.(data, this.getMode())) {
			this.expandedViewport.invalidate();
			return true;
		}
		if (this.modeIndex !== 0 && this.expandedViewport.handleViewportInput(data)) return true;
		if (
			this.canExpand() &&
			this.isFolded() &&
			!this.hasCollapsedPrimaryTarget() &&
			(matchesKey(data, "enter") || matchesKey(data, "space"))
		) {
			this.activate();
			return true;
		}
		if (this.canExpand() && matchesKey(data, "right")) {
			this.advance(1);
			return true;
		}
		if (this.canExpand() && matchesKey(data, "left")) {
			this.advance(-1);
			return true;
		}
		return false;
	}

	/** Handle Enter/Space while the action header owns keyboard focus. */
	handleHeaderInput(data: string): boolean {
		if (!this.canExpand() || (!matchesKey(data, "enter") && !matchesKey(data, "space"))) return false;
		if (this.isExpanded()) this.collapse();
		else this.open();
		return true;
	}

	/** Whether the action header is currently hovered by the pointer. */
	isHeaderHovered(): boolean {
		return this.hoveredTarget === "header";
	}

	/** Route header pointer events through this region's single disclosure FSM. */
	onHeaderMouse(event: TuiMouseEvent, width: number, height = 1): boolean {
		const boundedWidth = Math.max(0, Math.floor(width));
		const boundedHeight = Math.max(1, Math.floor(height));
		const inside =
			this.canExpand() && event.row >= 0 && event.row < boundedHeight && event.col >= 0 && event.col < boundedWidth;
		const headerCanOpen = this.isFolded();
		const interactive = inside && (this.isExpanded() || headerCanOpen);
		if (event.type === "leave") {
			const changed = this.hoveredTarget === "header" || this.pressed?.target === "header";
			if (this.hoveredTarget === "header") this.hoveredTarget = undefined;
			if (this.pressed?.target === "header") this.pressed = undefined;
			this.releaseCurrentIfUnowned();
			if (changed) this.options.requestRender();
			return false;
		}
		if (interactive) ensureFoldingRegistry().setCurrent(this);
		if (event.type === "enter" || event.type === "move") {
			const changed = this.hoveredTarget !== (interactive ? "header" : undefined);
			this.hoveredTarget = interactive ? "header" : undefined;
			if (changed) this.options.requestRender();
			return interactive;
		}
		if (event.type === "press" && inside && event.button === 0 && interactive) {
			this.pressed = { target: "header", button: 0 };
			return true;
		}
		if (event.type === "press" && inside && event.button === 2 && interactive) {
			this.pressed = { target: "header", button: 2 };
			return true;
		}
		if (event.type === "drag") {
			if (this.pressed?.target === "header") this.pressed = undefined;
			return false;
		}
		if (event.type === "release") {
			const pressed = this.pressed;
			const changed = this.hoveredTarget === "header" || pressed?.target === "header";
			this.pressed = pressed?.target === "header" ? undefined : pressed;
			this.hoveredTarget = undefined;
			const activate =
				pressed?.target === "header" &&
				(pressed.button === 0 || pressed.button === 2) &&
				inside &&
				this.isFolded() &&
				headerCanOpen;
			const collapse =
				pressed?.target === "header" && (pressed.button === 0 || pressed.button === 2) && inside && this.isExpanded();
			if (activate) this.open();
			if (collapse) this.collapse();
			if (changed && !activate && !collapse) this.options.requestRender();
			return activate || collapse;
		}
		return false;
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (this.modeIndex !== 0 && event.type === "wheel" && this.expandedViewport.onMouse(event)) return true;
		if (event.type === "leave") {
			const changed = this.hoveredTarget === "body" || this.pressed?.target === "body";
			if (this.hoveredTarget === "body") this.hoveredTarget = undefined;
			this.setOmissionRowHovered(false);
			if (this.pressed?.target === "body") this.pressed = undefined;
			this.releaseCurrentIfUnowned();
			if (changed) {
				this.expandedSurface.invalidate();
				this.options.requestRender();
			}
			return this.dispatchToMode(event);
		}
		const hit = this.hitControl(event.row, event.col);
		const inside = this.inside(event.row, event.col);
		if (inside && this.canExpand()) ensureFoldingRegistry().setCurrent(this);
		if (event.type === "enter" || event.type === "move") {
			const hoverable = this.isFolded() && hit;
			const nextHover = hoverable ? "body" : undefined;
			if (this.hoveredTarget !== nextHover) {
				this.hoveredTarget = nextHover;
				this.setOmissionRowHovered(hoverable);
				if (this.modeIndex !== 0) this.expandedSurface.invalidate();
				this.options.requestRender();
			}
			return hoverable || this.dispatchToMode(event);
		}
		if (event.type === "press" && event.button === 0 && this.isFolded() && hit) {
			this.pressed = { target: "body", button: 0 };
			return true;
		}
		if (event.type === "press" && event.button === 2 && this.isExpanded() && inside) {
			this.pressed = { target: "body", button: 2 };
			return true;
		}
		if (event.type === "drag") {
			if (this.pressed?.target === "body") this.pressed = undefined;
			return false;
		}
		if (event.type === "release") {
			const pressed = this.pressed;
			const changed = this.hoveredTarget === "body" || pressed?.target === "body";
			const activate =
				event.button === 0 && this.isFolded() && hit && pressed?.target === "body" && pressed.button === 0;
			const collapse =
				event.button === 2 && this.isExpanded() && inside && pressed?.target === "body" && pressed.button === 2;
			this.pressed = pressed?.target === "body" ? undefined : pressed;
			this.hoveredTarget = undefined;
			this.setOmissionRowHovered(false);
			if (activate) this.activate();
			if (collapse) this.collapse();
			if (changed && !activate && !collapse) this.options.requestRender();
			return activate || collapse || hit || this.dispatchToMode(event);
		}
		return this.dispatchToMode(event);
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		this.renderedWidth = boundedWidth;
		if (boundedWidth === 0) {
			this.setOmissionRowHovered(false);
			this.renderedHeight = 0;
			this.hintGeometry = [];
			this.sourceHintGeometry = [];
			return [];
		}
		this.rendered = true;
		this.syncFoldingTarget();
		if (this.modeIndex !== 0) {
			const rendered = this.expandedSurface.render(boundedWidth);
			this.renderedHeight = rendered.length;
			// Collapsed controls are not active in the expanded payload. Do not
			// carry their old geometry into body clicks after a mode transition.
			this.hintGeometry = [];
			return rendered;
		}
		const rendered = this.renderMode(boundedWidth);
		this.hintGeometry = this.sourceHintGeometry;
		return rendered;
	}

	private renderMode(boundedWidth: number): string[] {
		const mode = this.mode();
		this.setOmissionRowHovered(this.isFolded() && this.hoveredTarget === "body" && mode.activationRow === "omission");
		const lines = mode.component.render(boundedWidth);
		this.sourceHintGeometry = [];
		const colors = tuiTheme(this.options.theme);
		if (mode.activationRow !== undefined) {
			const row = resolveActivationRow(mode, lines.length);
			if (row === undefined || !Number.isInteger(row) || row < 0 || row >= lines.length) {
				this.renderedHeight = lines.length;
				return lines;
			}
			const provider = mode.activationRow === "omission" ? omissionProvider(mode.component) : undefined;
			const semanticOmission = provider?.setOmissionRowHovered !== undefined;
			const control =
				this.modeIndex === 0 && this.canExpand() && !semanticOmission
					? appendFoldingChevron(lines[row]!, boundedWidth, this.options.theme, false)
					: lines[row]!;
			if (this.isFolded())
				this.sourceHintGeometry.push({
					row,
					width: mode.activationRow === "omission" ? boundedWidth : visibleWidth(control),
				});
			this.renderedHeight = lines.length;
			return lines.map((line, index) =>
				index === row
					? this.hoveredTarget === "body" && !semanticOmission
						? this.styleControl(control, colors)
						: control
					: line,
			);
		}
		if (!mode.nextHint || this.modes.length === 1 || this.modeIndex !== 0) {
			this.renderedHeight = lines.length;
			return lines;
		}
		const plain = truncateToWidth(`… ${sanitizeTuiField(mode.nextHint)}`, boundedWidth, "…");
		// Keep the disclosure adjacent to the omitted middle, rather than making
		// it read like a footer after the last payload row.
		const hintRow = Math.floor(lines.length / 2);
		if (this.isFolded()) this.sourceHintGeometry.push({ row: hintRow, width: visibleWidth(plain) });
		const rendered = [...lines.slice(0, hintRow), this.styleControl(plain, colors), ...lines.slice(hintRow)];
		this.renderedHeight = rendered.length;
		return rendered;
	}

	invalidate(): void {
		this.hintGeometry = [];
		this.sourceHintGeometry = [];
		this.expandedSurface.invalidate();
		for (const mode of this.modes) mode.component.invalidate();
	}

	/** Invalidate only the bounded expanded projection, preserving child pointer state. */
	invalidateExpanded(): void {
		this.expandedSurface.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeFoldingTarget?.();
		this.removeFoldingTarget = undefined;
		this.expandedSurface.dispose();
		if (this.options.disposeReplacedModes !== false) disposeModes(this.modes);
	}

	private mode(): ToolViewMode {
		return this.modes[this.modeIndex]!;
	}

	private setOmissionRowHovered(hovered: boolean): void {
		const provider = this.mode().component as Partial<OmissionRowProvider>;
		provider.setOmissionRowHovered?.(hovered);
	}

	private advance(delta: number): void {
		const count = this.modes.length;
		const next = Math.max(0, Math.min(count - 1, this.modeIndex + delta));
		if (next === this.modeIndex) return;
		this.expandedViewport.invalidate();
		this.setMode(this.modes[next]!.id);
	}

	private syncFoldingTarget(): void {
		if (!this.disposed && this.rendered && this.canExpand() && !this.removeFoldingTarget) {
			this.removeFoldingTarget = ensureFoldingRegistry().register(this);
		} else if ((this.disposed || !this.canExpand()) && this.removeFoldingTarget) {
			this.removeFoldingTarget();
			this.removeFoldingTarget = undefined;
		}
	}

	private styleControl(plain: string, colors: ReturnType<typeof tuiTheme>): string {
		if (this.hoveredTarget === "body")
			return colors.bg(
				"surface.hover",
				colors.fg("text.secondary", `${plain}${" ".repeat(Math.max(0, this.renderedWidth - visibleWidth(plain)))}`),
			);
		return colors.fg("text.muted", plain);
	}

	private hitControl(row: number, col: number): boolean {
		return this.hintGeometry.some((geometry) => row === geometry.row && col >= 0 && col < geometry.width);
	}

	private inside(row: number, col: number): boolean {
		return row >= 0 && row < this.renderedHeight && col >= 0 && col < this.renderedWidth;
	}

	private dispatchToMode(event: TuiMouseEvent): boolean {
		const handler = (this.mode().component as Component & { onMouse?(event: TuiMouseEvent): boolean }).onMouse;
		if (!handler) return false;
		const scrollTop = this.modeIndex !== 0 ? this.expandedViewport.scrollOffset : 0;
		const handled = handler.call(this.mode().component, { ...event, row: event.row + scrollTop });
		if (handled) this.expandedViewport.invalidate();
		return handled;
	}

	private releaseCurrentIfUnowned(): void {
		if (this.hoveredTarget === undefined && this.pressed === undefined && !this.focused) clearFoldingCurrent(this);
	}
}

function resolveActivationRow(mode: ToolViewMode, lineCount: number): number | undefined {
	const row =
		mode.activationRow === "last"
			? lineCount - 1
			: mode.activationRow === "omission"
				? omissionRow(mode.component)
				: mode.activationRow;
	if (row === undefined) return undefined;
	return row;
}

function omissionRow(component: Component): number | undefined {
	const provider = component as Partial<OmissionRowProvider>;
	const row = provider.getOmissionRow?.();
	return typeof row === "number" && Number.isInteger(row) && row >= 0 ? row : undefined;
}

function omissionProvider(component: Component): Partial<OmissionRowProvider> | undefined {
	const provider = component as Partial<OmissionRowProvider>;
	return typeof provider.getOmissionRow === "function" && typeof provider.setOmissionRowHovered === "function"
		? provider
		: undefined;
}

function disposeRemovedModes(previous: readonly ToolViewMode[], next: readonly ToolViewMode[]): void {
	const retained = new Set(next.map((mode) => mode.component));
	disposeModes(previous.filter((mode) => !retained.has(mode.component)));
}

function disposeModes(modes: readonly ToolViewMode[]): void {
	const disposed = new Set<Component>();
	for (const { component } of modes) {
		if (disposed.has(component)) continue;
		disposed.add(component);
		(component as Component & { dispose?(): void }).dispose?.();
	}
}
