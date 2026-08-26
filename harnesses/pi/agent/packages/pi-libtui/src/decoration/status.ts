import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type TuiForegroundToken, type TuiTheme, tuiTheme } from "../color/theme.ts";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import { activityFrame, mountConfiguredAnimation, type MotionMount, type MotionScheduler } from "../motion.ts";
import { RenderedLinesCache } from "../render-cache.ts";
import { icon, type TuiIconName } from "./glyphs.ts";

/** Options for the pure determinate or indeterminate progress renderer. */
export interface ProgressFrameOptions {
	width: number;
	/** A finite value from zero to one. Omit for an indeterminate moving segment. */
	value?: number;
	elapsedMs?: number;
	reducedMotion?: boolean;
	filled?: string;
	empty?: string;
	tone?: TuiForegroundToken;
	trackTone?: TuiForegroundToken;
}

/** Render a fixed-width progress frame using semantic foreground colors. */
export function progressFrame(colors: TuiTheme, options: ProgressFrameOptions): string {
	const width = Math.max(0, Math.floor(options.width));
	if (width === 0) return "";
	const filled = cellGlyph(options.filled, "━");
	const empty = cellGlyph(options.empty, "─");
	const tone = options.tone ?? "accent";
	const trackTone = options.trackTone ?? "text.muted";
	if (options.value !== undefined && Number.isFinite(options.value)) {
		const count = Math.round(Math.max(0, Math.min(1, options.value)) * width);
		return `${colors.fg(tone, filled.repeat(count))}${colors.fg(trackTone, empty.repeat(width - count))}`;
	}
	if (options.reducedMotion) return colors.fg(trackTone, empty.repeat(width));
	const segmentWidth = Math.max(1, Math.min(width, Math.ceil(width / 4)));
	const travel = width + segmentWidth;
	const offset = Math.floor(Math.max(0, options.elapsedMs ?? 0) / 70) % travel;
	const start = Math.max(0, offset - segmentWidth);
	const end = Math.min(width, offset);
	return `${colors.fg(trackTone, empty.repeat(start))}${colors.fg(tone, filled.repeat(Math.max(0, end - start)))}${colors.fg(trackTone, empty.repeat(width - end))}`;
}

/** Construction options for a stream-friendly activity row. */
export interface ActivityIndicatorOptions {
	theme: Theme;
	label: string;
	detail?: string;
	requestRender(): void;
	cadenceMs?: number;
	reducedMotion?: boolean;
	spinnerFrames?: readonly string[];
	scheduler?: MotionScheduler;
	/** Optional repaint deadline for callers that cannot own component disposal. */
	maxDurationMs?: number;
	/** Initial-time seam for deterministic component tests. */
	now?: () => number;
}

/** A compact animated activity row backed by the shared cadence scheduler. */
export class ActivityIndicator implements Component {
	private readonly cache = new RenderedLinesCache();
	private readonly startedAtMs: number;
	private nowMs: number;
	private readonly mount: MotionMount;

	constructor(private readonly options: ActivityIndicatorOptions) {
		this.startedAtMs = options.now?.() ?? performance.now();
		this.nowMs = this.startedAtMs;
		this.mount = mountConfiguredAnimation(options, {
			cadenceMs: options.cadenceMs,
			reducedMotion: options.reducedMotion,
			maxDurationMs: options.maxDurationMs,
			scheduler: options.scheduler,
			onFrame: (nowMs) => {
				this.nowMs = nowMs;
			},
		});
	}

	render(width: number): string[] {
		const elapsedMs = Math.max(0, this.nowMs - this.startedAtMs);
		const frame = activityFrame(tuiTheme(this.options.theme), rowText(this.options.label), elapsedMs, {
			frames: this.options.spinnerFrames,
			cadenceMs: this.options.cadenceMs,
			reducedMotion: this.options.reducedMotion,
		});
		const marker = frame.marker ? `${frame.marker} ` : "";
		const detailText = this.options.detail === undefined ? undefined : rowText(this.options.detail);
		const key = `${frame.marker}\0${frame.text}\0${detailText ?? ""}`;
		return this.cache.get(width, key, () => {
			if (width <= 0) return [];
			const colors = tuiTheme(this.options.theme);
			const separator = detailText ? colors.fg("text.muted", " · ") : "";
			const detail = detailText ? colors.fg("text.secondary", detailText) : "";
			const line = `${marker}${frame.text}${separator}${detail}`;
			return [truncateToWidth(line, width, "…")];
		});
	}

	invalidate(): void {
		this.cache.clear();
	}

	/** Release the scheduler registration. Safe to call more than once. */
	dispose(): void {
		this.mount.dispose();
	}
}

/** Construction options for a cached progress-bar component. */
export interface ProgressBarOptions extends Omit<ProgressFrameOptions, "width"> {
	theme: Theme;
	label?: string;
	showPercentage?: boolean;
}

/** A static, allocation-bounded determinate progress bar. */
export class ProgressBar implements Component {
	private readonly cache = new RenderedLinesCache();

	constructor(private readonly options: ProgressBarOptions) {}

	render(width: number): string[] {
		const value = this.options.value;
		const percentage = value === undefined ? "" : `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
		const key = `${value ?? "indeterminate"}\0${this.options.elapsedMs ?? 0}\0${this.options.reducedMotion ?? false}`;
		return this.cache.get(width, key, () => {
			if (width <= 0) return [];
			const colors = tuiTheme(this.options.theme);
			const labelText = this.options.label === undefined ? "" : rowText(this.options.label);
			const label = labelText ? colors.fg("text.secondary", labelText) : "";
			const suffix = this.options.showPercentage && percentage ? colors.fg("text.muted", percentage) : "";
			const fixed = visibleWidth(label) + visibleWidth(suffix) + (label ? 1 : 0) + (suffix ? 1 : 0);
			const barWidth = Math.max(1, width - fixed);
			const bar = progressFrame(colors, { ...this.options, width: barWidth });
			return [truncateToWidth(`${label}${label ? " " : ""}${bar}${suffix ? ` ${suffix}` : ""}`, width, "")];
		});
	}

	invalidate(): void {
		this.cache.clear();
	}
}

function cellGlyph(value: string | undefined, fallback: string): string {
	if (value === undefined) return fallback;
	const safe = sanitizeTuiText(value);
	return safe === value && safe.trim().length > 0 && visibleWidth(safe) === 1 ? safe : fallback;
}

function rowText(value: string): string {
	return sanitizeTuiText(value).replace(/[\n\r]+/gu, " ");
}

/** A title label with an optional icon resolved from the active semantic icon pack. */
export interface TuiTitle {
	/** Human-readable title text. */
	label: string;
	/** Semantic icon token rendered before the label. */
	icon?: TuiIconName;
}

/** A plain title string or a structured semantic title. */
export type TuiTitleValue = string | TuiTitle;

/** A title value or callback resolved on every render for dynamic labels. */
export type TuiTitleSource = TuiTitleValue | (() => TuiTitleValue);

/**
 * Resolve a static or dynamic semantic title into display text.
 * @param source Title value or callback evaluated at call time.
 * @returns The label, prefixed by the active icon-pack glyph when an icon exists.
 */
export function resolveTuiTitle(source: TuiTitleSource): string {
	const title = typeof source === "function" ? source() : source;
	if (typeof title === "string") return title;
	return title.icon ? `${icon(title.icon)} ${title.label}` : title.label;
}
