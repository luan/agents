import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type TuiBackgroundToken, tuiTheme } from "./color/theme.ts";
import { TEXT_INTERACTION_TARGET, type TextInteractionTarget, type TuiMouseEvent } from "./mouse.ts";
import { getTuiRenderEpoch } from "./render-epoch.ts";

export interface BackgroundSurfaceOptions {
	theme: Theme;
	component: Component;
	background?: TuiBackgroundToken;
	/** Leave shorter content unpainted. Defaults to one rendered row. */
	minimumRows?: number;
}

/** Canonical background for multiline tool and foldable content. */
export const TOOL_SURFACE_BACKGROUND: TuiBackgroundToken = "surface.inset";

/** Paint a component's rows edge-to-edge without adding a border, padding, or indentation. */
export class BackgroundSurface implements Component, TextInteractionTarget {
	readonly [TEXT_INTERACTION_TARGET] = true as const;
	private cachedWidth = -1;
	private cachedEpoch = -1;
	private cachedInput: string[] | undefined;
	private cachedOutput: string[] | undefined;

	constructor(private readonly options: BackgroundSurfaceOptions) {}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0) return [];
		const epoch = getTuiRenderEpoch();
		const input = this.options.component.render(boundedWidth);
		if (
			this.cachedWidth === boundedWidth &&
			this.cachedEpoch === epoch &&
			this.cachedInput?.length === input.length &&
			this.cachedInput.every((line, index) => line === input[index]) &&
			this.cachedOutput
		)
			return this.cachedOutput;
		const minimumRows = Math.max(1, Math.floor(this.options.minimumRows ?? 1));
		const output =
			input.length < minimumRows
				? input
				: paintRows(
						input,
						boundedWidth,
						tuiTheme(this.options.theme).bgAnsi(this.options.background ?? TOOL_SURFACE_BACKGROUND),
					);
		this.cachedWidth = boundedWidth;
		this.cachedEpoch = epoch;
		this.cachedInput = [...input];
		this.cachedOutput = output;
		return output;
	}

	invalidate(): void {
		this.cachedInput = undefined;
		this.cachedOutput = undefined;
		this.options.component.invalidate();
	}

	setViewportFocus(focused: boolean): void {
		this.target().setViewportFocus?.(focused);
	}

	isViewportFocused(): boolean {
		return this.target().isViewportFocused?.() ?? false;
	}

	handleViewportInput(data: string): boolean {
		const target = this.target();
		return target.handleViewportInput?.(data) ?? target.handleInput?.(data) ?? false;
	}

	handleInput(data: string): void {
		this.target().handleInput?.(data);
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.target().onMouse?.(event) ?? false;
	}

	dispose(): void {
		(this.options.component as Component & { dispose?(): void }).dispose?.();
	}

	private target() {
		return this.options.component as Component & {
			setViewportFocus?(focused: boolean): void;
			isViewportFocused?(): boolean;
			handleViewportInput?(data: string): boolean;
			handleInput?(data: string): boolean;
			onMouse?(event: TuiMouseEvent): boolean;
		};
	}
}

function paintRows(input: readonly string[], width: number, background: string): string[] {
	return input.map((line) => {
		const clipped = truncateToWidth(line, width, "…")
			.replaceAll("\x1b[49m", `\x1b[49m${background}`)
			.replaceAll("\x1b[0m", `\x1b[0m${background}`);
		// Child content may leave a foreground/style SGR active (for example an
		// underline or an external background). Reset before painting padding so
		// that a short row cannot leak that style across the rest of the surface.
		const padded = `${clipped}\x1b[0m${background}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return `${background}${padded}\x1b[49m`;
	});
}
