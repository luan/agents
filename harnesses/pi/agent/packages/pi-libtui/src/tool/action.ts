import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type TuiForegroundColor, tuiTheme } from "../color/theme.ts";
import { sanitizeTuiField } from "../content/terminal-text.ts";
import { icon } from "../decoration/glyphs.ts";
import { type MotionMount, sharedMotionScheduler, spinnerFrame } from "../motion.ts";
import { RenderedLinesCache } from "../render-cache.ts";

/** Lifecycle state shared by semantic tool transcript rows. */
export type ToolTranscriptStatus = "queued" | "running" | "succeeded" | "failed" | "warning";

/** The single sentence which identifies a tool action. */
export interface ToolActionView {
	verb: string;
	status: ToolTranscriptStatus;
	detail?: string;
	meta?: readonly string[];
	/** Override the status marker, or hide it for a markerless grammar. */
	marker?: string | false;
	/** Optional identity color for a custom marker, independent of lifecycle status. */
	markerTone?: TuiForegroundColor;
}

export interface ToolActionOptions {
	theme: Theme;
	view: ToolActionView;
}

/** Cached, width-safe action row used by tool calls and results. */
export class ToolAction implements Component {
	private readonly cache = new RenderedLinesCache();
	private revision = 0;

	constructor(private readonly options: ToolActionOptions) {}

	update(view: ToolActionView): void {
		if (this.options.view === view) return;
		this.options.view = view;
		this.revision += 1;
		this.cache.clear();
	}

	render(width: number): string[] {
		return this.cache.get(width, String(this.revision), () =>
			width <= 0 ? [] : [renderToolAction(this.options.theme, this.options.view, width)],
		);
	}

	invalidate(): void {
		this.cache.clear();
	}
}

/**
 * Render one semantic action sentence without imposing a particular marker grammar.
 *
 * @param theme Active Pi theme translated through semantic libtui colors.
 * @param view Tool-owned words, marker, state, and essential metadata.
 * @param width Maximum terminal-cell width for the returned row.
 * @returns One ANSI-styled, width-safe transcript row.
 */
function renderToolAction(theme: Theme, view: ToolActionView, width: number): string {
	const colors = tuiTheme(theme);
	const status = actionStatus(view.status);
	const markerValue = view.marker === false ? "" : sanitizeTuiField(view.marker ?? status.glyph);
	const marker = markerValue ? `${colors.fg(view.markerTone ?? status.tone, markerValue)} ` : "";
	let line = `${marker}${colors.fg("text.secondary", theme.bold(sanitizeTuiField(view.verb)))}`;
	if (view.detail)
		line += `${colors.fg("text.muted", " · ")}${colors.fg("text.secondary", sanitizeTuiField(view.detail))}`;
	if (view.meta?.length)
		line += `${colors.fg("text.muted", " · ")}${colors.fg("text.muted", view.meta.map(sanitizeTuiField).join(" · "))}`;
	return truncateToWidth(line, Math.max(0, width), "…");
}

export interface LiveToolActionOptions extends ToolActionOptions {
	requestRender(): void;
	running?: boolean;
	cadenceMs?: number;
	reducedMotion?: boolean;
}

/** Tool action with a shared-scheduler activity glyph composed before its chosen grammar. */
export class LiveToolAction implements Component {
	private readonly action: ToolAction;
	private readonly cache = new RenderedLinesCache();
	private view: ToolActionView;
	private running: boolean;
	private startedAt = performance.now();
	private now = this.startedAt;
	private motion: MotionMount | undefined;

	constructor(private readonly options: LiveToolActionOptions) {
		this.view = options.view;
		this.running = options.running ?? options.view.status === "running";
		this.action = new ToolAction({ theme: options.theme, view: this.view });
		this.syncMotion();
	}

	update(view: ToolActionView, running = view.status === "running"): void {
		const started = !this.running && running;
		this.view = view;
		this.running = running;
		if (started) this.startedAt = performance.now();
		this.action.update(view);
		this.cache.clear();
		this.syncMotion();
	}

	render(width: number): string[] {
		const frame = this.running
			? spinnerFrame(this.now - this.startedAt, {
					cadenceMs: this.options.cadenceMs,
					reducedMotion: this.options.reducedMotion,
				})
			: "";
		const line = this.action.render(Math.max(0, width - (frame ? 2 : 0)))[0];
		const key = `${frame}\0${line ?? ""}`;
		return this.cache.get(width, key, () =>
			line === undefined ? [] : [`${frame ? `${tuiTheme(this.options.theme).fg("accent", frame)} ` : ""}${line}`],
		);
	}

	invalidate(): void {
		this.cache.clear();
		this.action.invalidate();
	}

	dispose(): void {
		this.motion?.dispose();
		this.motion = undefined;
	}

	private syncMotion(): void {
		if (this.running && !this.motion && !this.options.reducedMotion) {
			this.motion = sharedMotionScheduler.mount(
				{ requestRender: this.options.requestRender },
				{
					cadenceMs: this.options.cadenceMs ?? 80,
					onFrame: (now) => {
						this.now = now;
					},
				},
			);
		} else if (!this.running && this.motion) {
			this.motion.dispose();
			this.motion = undefined;
		}
	}
}

function actionStatus(status: ToolTranscriptStatus): {
	glyph: string;
	tone: "accent" | "positive" | "negative" | "warning" | "text.muted";
} {
	switch (status) {
		case "running":
			return { glyph: "●", tone: "accent" };
		case "succeeded":
			return { glyph: "•", tone: "positive" };
		case "failed":
			return { glyph: icon("error"), tone: "negative" };
		case "warning":
			return { glyph: icon("warning"), tone: "warning" };
		case "queued":
			return { glyph: "○", tone: "text.muted" };
	}
}
