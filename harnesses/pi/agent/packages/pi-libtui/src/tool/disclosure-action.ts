import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { TEXT_INTERACTION_TARGET, type TextInteractionTarget, type TuiMouseEvent } from "../mouse.ts";
import { appendFoldingChevron, type ToolViewRegion } from "./view-region.ts";

/** Make an existing action row the primary disclosure control without owning fold state. */
export class ToolDisclosureAction implements Component, TextInteractionTarget {
	readonly [TEXT_INTERACTION_TARGET] = true as const;
	private width = 0;
	private height = 1;

	constructor(
		private readonly theme: Theme,
		private action: Component,
		private region: ToolViewRegion,
		private readonly requestRender: () => void,
	) {}

	setAction(action: Component): void {
		if (action === this.action) return;
		(this.action as Component & { dispose?(): void }).dispose?.();
		this.action = action;
		this.requestRender();
	}

	setRegion(region: ToolViewRegion): void {
		if (region === this.region) return;
		const focused = this.region.isViewportFocused();
		this.region = region;
		if (focused) region.setViewportFocus(true);
		this.requestRender();
	}

	render(width: number): string[] {
		this.width = Math.max(0, Math.floor(width));
		const lines = this.action.render(this.width);
		this.height = Math.max(1, lines.length);
		const headerCanOpen = this.region.isFolded() && !this.region.hasCollapsedPrimaryTarget();
		const decorated =
			this.region.canExpand() && (this.region.isExpanded() || headerCanOpen) && lines.length > 0
				? [appendFoldingChevron(lines[0]!, this.width, this.theme, this.region.isExpanded()), ...lines.slice(1)]
				: lines;
		if (!this.region.isHeaderHovered() || !this.region.canExpand()) return decorated;
		const colors = tuiTheme(this.theme);
		const foreground = colors.contrastBackground(colors.color("surface.hover"));
		return decorated.map((line) => {
			const plain = stripTerminalSequences(line);
			return colors.bg(
				"surface.hover",
				colors.fg(foreground, `${plain}${" ".repeat(Math.max(0, this.width - visibleWidth(plain)))}`),
			);
		});
	}

	setViewportFocus(focused: boolean): void {
		this.region.setViewportFocus(focused);
	}

	isViewportFocused(): boolean {
		return this.region.isViewportFocused();
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.region.onHeaderMouse(event, this.width, this.height);
	}

	handleViewportInput(data: string): boolean {
		return this.region.handleHeaderInput(data);
	}

	invalidate(): void {
		this.action.invalidate();
	}

	dispose(): void {
		(this.action as Component & { dispose?(): void }).dispose?.();
		this.region.dispose();
	}
}
