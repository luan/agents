import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type TuiForegroundToken, tuiTheme } from "../color/theme.ts";
import type { ViewportRect } from "../mouse.ts";
import type { SelectionPoint } from "../selection.ts";
import { getTuiPillSeparators, icon, type TuiIconName } from "./glyphs.ts";
import { backgroundAnsiAtColumn, renderPill } from "./powerline-pill.ts";

/** Content displayed by a short-lived cursor-local pill. */
export interface TransientPillMessage {
	/** Short status text. */
	label: string;
	/** Semantic icon displayed before the label. */
	icon: TuiIconName;
	/** Semantic foreground applied to the icon. */
	tone: TuiForegroundToken;
}

/** Bounds used to place a transient pill around a terminal cell. */
export interface TransientPillPlacementRequest {
	/** Absolute cell around which the pill is centered. */
	anchor: SelectionPoint;
	/** Natural pill width before visible-bounds clamping. */
	width: number;
	/** Complete terminal width. */
	screenWidth: number;
	/** Complete terminal height. */
	screenHeight: number;
	/** Optional transcript viewport used as tighter visible bounds. */
	viewport?: ViewportRect;
}

/** Construction options for {@link TransientPill}. */
export interface TransientPillOptions {
	/** Active Pi theme used for semantic colors. */
	theme: Theme;
	/** Request a host render after feedback appears or expires. */
	requestRender(): void;
	/** Visibility duration in milliseconds; defaults to 1500. */
	durationMs?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Center a one-row pill above its anchor, flipping below and clamping to visible bounds.
 * @param request Anchor, terminal bounds, and natural pill width.
 * @returns A visible one-row rectangle, or undefined when no adjacent row exists.
 */
export function placeTransientPill(request: TransientPillPlacementRequest):
	| {
			x: number;
			y: number;
			width: number;
			height: 1;
	  }
	| undefined {
	const left = request.viewport?.x ?? 0;
	const top = request.viewport?.y ?? 0;
	const right = request.viewport
		? Math.min(request.screenWidth, request.viewport.x + request.viewport.width)
		: request.screenWidth;
	const bottom = request.viewport
		? Math.min(request.screenHeight, request.viewport.y + request.viewport.height)
		: request.screenHeight;
	const width = Math.min(Math.max(0, Math.floor(request.width)), Math.max(0, right - left));
	if (width === 0 || bottom <= top) return undefined;
	const anchorRow = clamp(Math.floor(request.anchor.row), top, bottom - 1);
	const y = anchorRow - 1 >= top ? anchorRow - 1 : anchorRow + 1 < bottom ? anchorRow + 1 : undefined;
	if (y === undefined) return undefined;
	const center = Math.floor(request.anchor.col) + 0.5;
	const x = clamp(Math.round(center - width / 2), left, right - width);
	return { x, y, width, height: 1 };
}

/** A reusable, timed pill composited near a terminal cursor or selection anchor. */
export class TransientPill {
	private current: { message: TransientPillMessage; anchor: SelectionPoint } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	/** @param options Theme, render callback, and optional display duration. */
	constructor(private readonly options: TransientPillOptions) {}

	/**
	 * Display feedback and restart its expiry timer.
	 * @param message Semantic icon, tone, and short label.
	 * @param anchor Absolute cursor or selection cell around which to place the pill.
	 */
	show(message: TransientPillMessage, anchor: SelectionPoint): void {
		this.current = { message, anchor };
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.current = undefined;
			this.timer = undefined;
			this.options.requestRender();
		}, this.options.durationMs ?? 1_500);
		this.options.requestRender();
	}

	/** Hide current feedback and request a render. */
	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.current) return;
		this.current = undefined;
		this.options.requestRender();
	}

	/** Cancel expiry and release the current message without requesting another render. */
	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.current = undefined;
	}

	/**
	 * Composite current feedback over a styled terminal screen.
	 * @param screen Complete styled terminal rows.
	 * @param bounds Terminal dimensions and optional transcript viewport.
	 * @returns A decorated screen copy, or an unchanged copy when no pill is visible.
	 */
	composite(screen: readonly string[], bounds: { width: number; height: number; viewport?: ViewportRect }): string[] {
		if (!this.current) return [...screen];
		const [leftCap, rightCap] = getTuiPillSeparators();
		const naturalWidth =
			visibleWidth(leftCap) +
			visibleWidth(icon(this.current.message.icon)) +
			1 +
			visibleWidth(this.current.message.label) +
			visibleWidth(rightCap);
		const placement = placeTransientPill({
			anchor: this.current.anchor,
			width: naturalWidth,
			screenWidth: bounds.width,
			screenHeight: bounds.height,
			viewport: bounds.viewport,
		});
		if (!placement) return [...screen];
		const result = [...screen];
		const base = result[placement.y];
		if (base === undefined) return result;
		const destination = backgroundAnsiAtColumn(base, placement.x);
		const colors = tuiTheme(this.options.theme);
		const iconGlyph = icon(this.current.message.icon);
		const labelWidth = Math.max(
			0,
			placement.width - visibleWidth(leftCap) - visibleWidth(iconGlyph) - 1 - visibleWidth(rightCap),
		);
		const label = truncateToWidth(this.current.message.label, labelWidth, "…");
		const blue = colors.color({ hue: "blue", shade: 2 });
		const background =
			this.current.message.tone === "warning"
				? "badge.warning"
				: this.current.message.tone === "negative"
					? "badge.negative"
					: blue;
		const pill = renderPill(
			this.options.theme,
			{ icon: this.current.message.icon, iconTone: this.current.message.tone, label },
			background,
			"text.primary",
			undefined,
			destination,
		);
		result[placement.y] = compositeTuiLine(
			base,
			pill,
			placement.x,
			placement.width,
			Math.max(visibleWidth(base), placement.x + placement.width),
		);
		return result;
	}
}
