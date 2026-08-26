import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	highlightSyntaxBlock,
	type ActivityAnimationOverrides,
	activityAnimatesText,
	activityFrame,
	getTuiAppearance,
	type MotionMount,
	mountConfiguredAnimation,
	RenderedLinesCache,
	sanitizeTuiField,
	sanitizeTuiText,
	type TuiActivityMarkerStyle,
	type TuiForegroundColor,
	type TuiShimmerStyle,
	tuiTheme,
	whenSyntaxReady,
} from "pi-libtui";
import type { ToolTranscriptStatus } from "pi-libtui/tool";

export interface ShellCommandActionView {
	command: string;
	shell?: string;
	status: ToolTranscriptStatus;
	running?: boolean;
	meta?: readonly string[];
}

export interface ShellCommandActionOptions {
	theme: Theme;
	view: ShellCommandActionView;
	requestRender(): void;
	maxRows?: number;
	reducedMotion?: boolean;
	animation?: Readonly<ActivityAnimationOverrides>;
}

interface ShellPiece {
	text: string;
	tone: TuiForegroundColor;
}

interface ShellActivity extends ActivityAnimationOverrides {
	elapsedMs: number;
	markerStyle: TuiActivityMarkerStyle;
	shimmerStyle: TuiShimmerStyle;
	shimmerMarker: boolean;
	animationSpeed: NonNullable<ActivityAnimationOverrides["animationSpeed"]>;
}

/** Width-aware, copy-friendly shell command header with cached token styling. */
export class ShellCommandAction implements Component {
	private readonly cache = new RenderedLinesCache();
	private view: ShellCommandActionView;
	private running: boolean;
	private startedAt = performance.now();
	private now = this.startedAt;
	private motion: MotionMount | undefined;
	private revision = 0;
	private pieces: readonly ShellPiece[];
	private disposed = false;
	private syntaxReadyRequested = false;

	constructor(private readonly options: ShellCommandActionOptions) {
		this.view = options.view;
		this.pieces = shellPieces(sanitizeTuiText(options.view.command), options.view.shell);
		this.running = options.view.running ?? options.view.status === "running";
		this.syncMotion();
	}

	update(view: ShellCommandActionView, running = view.running ?? view.status === "running"): void {
		if (!this.running && running) this.startedAt = performance.now();
		if (view.command !== this.view.command || view.shell !== this.view.shell) {
			this.pieces = shellPieces(sanitizeTuiText(view.command), view.shell);
		}
		this.view = view;
		this.running = running;
		this.revision += 1;
		this.cache.clear();
		this.syncMotion();
	}

	render(width: number): string[] {
		const boundedWidth = Math.max(0, Math.floor(width));
		if (boundedWidth === 0) return [];
		this.requestSyntaxReady();
		const appearance = getTuiAppearance();
		const markerStyle = this.options.animation?.markerStyle ?? appearance.activityMarker;
		const shimmerStyle = this.options.animation?.shimmerStyle ?? appearance.shimmer;
		const activity = this.running
			? {
					...this.options.animation,
					elapsedMs: this.now - this.startedAt,
					markerStyle: this.options.reducedMotion && markerStyle !== "off" ? ("static" as const) : markerStyle,
					shimmerStyle: this.options.reducedMotion ? ("off" as const) : shimmerStyle,
					shimmerMarker: this.options.animation?.shimmerMarker ?? appearance.shimmerMarker,
					animationSpeed: this.options.animation?.animationSpeed ?? appearance.animationSpeed,
				}
			: undefined;
		const key = `${this.revision}\0${activity?.markerStyle ?? ""}\0${activity?.shimmerStyle ?? ""}\0${activity?.shimmerMarker ?? ""}\0${activity?.animationSpeed ?? ""}\0${activity?.elapsedMs ?? ""}`;
		return this.cache.get(boundedWidth, key, () =>
			renderShellCommand(this.options.theme, this.view, boundedWidth, activity, this.options.maxRows, this.pieces),
		);
	}

	invalidate(): void {
		this.cache.clear();
	}

	dispose(): void {
		this.disposed = true;
		this.motion?.dispose();
		this.motion = undefined;
	}

	private requestSyntaxReady(): void {
		if (this.syntaxReadyRequested) return;
		this.syntaxReadyRequested = true;
		whenSyntaxReady(() => {
			if (this.disposed) return;
			this.pieces = shellPieces(sanitizeTuiText(this.view.command), this.view.shell);
			this.cache.clear();
			this.options.requestRender();
		});
	}

	private syncMotion(): void {
		if (this.running && !this.motion) {
			this.motion = mountConfiguredAnimation(
				{ requestRender: this.options.requestRender },
				{
					...this.options.animation,
					reducedMotion: this.options.reducedMotion,
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

function renderShellCommand(
	theme: Theme,
	view: ShellCommandActionView,
	width: number,
	activity: ShellActivity | undefined,
	maxRows = 6,
	pieces: readonly ShellPiece[] = shellPieces(view.command, view.shell),
): string[] {
	const colors = tuiTheme(theme);
	const promptTone = view.status === "failed" ? "negative" : view.status === "queued" ? "text.muted" : "positive";
	if (width <= 2) return [colors.fg(promptTone, truncateToWidth("$ ", width, ""))];
	const activityMarker = activity
		? activityFrame(colors, "", activity.elapsedMs, {
				markerStyle: activity.markerStyle,
				shimmerStyle: activity.shimmerStyle,
				shimmerMarker: activity.shimmerMarker,
				animationSpeed: activity.animationSpeed,
			}).marker
		: "";
	const prefix = `${activityMarker ? `${activityMarker} ` : ""}${colors.fg(promptTone, "$")} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const rows = wrapPieces(pieces, contentWidth);
	const limit = Math.max(1, Math.floor(maxRows));
	const visibleRows = rows.slice(0, limit);
	if (rows.length > limit) {
		const last = visibleRows.length - 1;
		visibleRows[last] = [
			...trimPieces(visibleRows[last]!, Math.max(0, contentWidth - 1)),
			{ text: "…", tone: "text.muted" },
		];
	}
	const rendered = visibleRows.map((row, index) => {
		const lead = index === 0 ? prefix : continuation;
		if (activity && activityAnimatesText(activity.shimmerStyle)) {
			const text = row.map((piece) => piece.text).join("");
			return `${lead}${
				activityFrame(colors, text, activity.elapsedMs + index * 70, {
					markerStyle: activity.markerStyle,
					shimmerStyle: activity.shimmerStyle,
					shimmerMarker: activity.shimmerMarker,
					animationSpeed: activity.animationSpeed,
				}).text
			}`;
		}
		return `${lead}${row.map((piece) => colors.fg(piece.tone, piece.text)).join("")}`;
	});
	if (view.meta?.length) {
		const metadata = `· ${view.meta.map(sanitizeTuiField).join(" · ")}`;
		const last = rendered.length - 1;
		const gap = Math.max(1, width - visibleWidth(rendered[last]!) - visibleWidth(metadata));
		if (gap > 1) rendered[last] += `${" ".repeat(gap)}${colors.fg("text.muted", metadata)}`;
		else {
			const available = Math.max(0, width - visibleWidth(continuation));
			rendered.push(`${continuation}${colors.fg("text.muted", truncateToWidth(metadata, available, "…"))}`);
		}
	}
	return rendered;
}

function trimPieces(pieces: readonly ShellPiece[], width: number): ShellPiece[] {
	const result: ShellPiece[] = [];
	let remaining = width;
	for (const piece of pieces) {
		if (remaining <= 0) break;
		const text = sliceByColumn(piece.text, 0, remaining, true);
		if (text) result.push({ ...piece, text });
		remaining -= visibleWidth(text);
	}
	return result;
}

function shellPieces(command: string, shell?: string): ShellPiece[] {
	const source = stripTerminalSequences(command).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
	const sourceLines = source.split("\n");
	const highlightedLines = highlightSyntaxBlock(source, shellSyntaxFilename(shell));
	const pieces: ShellPiece[] = [];
	for (const [lineIndex, line] of sourceLines.entries()) {
		const sourceSpans = highlightedLines[lineIndex] ?? [];
		const spans = sourceSpans.map((span) => span.text).join("") === line ? sourceSpans : [{ text: line }];
		for (const span of spans) {
			if (span.text) pieces.push({ text: span.text, tone: span.foreground ?? "text.primary" });
		}
		if (lineIndex < sourceLines.length - 1) pieces.push({ text: "\n", tone: "text.primary" });
	}
	return pieces;
}

const SHELL_SYNTAX_FILENAMES = {
	bash: "script.bash",
	fish: "script.fish",
	sh: "script.sh",
	zsh: "script.zsh",
} as const;

function shellSyntaxFilename(shell: string | undefined): string {
	const basename = shell
		?.replace(/\\/gu, "/")
		.split("/")
		.at(-1)
		?.toLowerCase()
		.replace(/\.exe$/u, "");
	return (basename && SHELL_SYNTAX_FILENAMES[basename as keyof typeof SHELL_SYNTAX_FILENAMES]) || "script.sh";
}

function wrapPieces(pieces: readonly ShellPiece[], width: number): ShellPiece[][] {
	const rows: ShellPiece[][] = [[]];
	let used = 0;
	const nextRow = () => {
		rows.push([]);
		used = 0;
	};
	for (const piece of pieces) {
		if (piece.text === "\n") {
			nextRow();
			continue;
		}
		let text = used === 0 ? piece.text.replace(/^\s+/u, "") : piece.text;
		while (text.length > 0) {
			const available = width - used;
			if (available <= 0) {
				nextRow();
				text = text.replace(/^\s+/u, "");
				continue;
			}
			const textWidth = visibleWidth(text);
			if (textWidth <= available) {
				if (text) rows.at(-1)!.push({ ...piece, text });
				used += textWidth;
				break;
			}
			if (/^\s+$/u.test(text) || (used > 0 && textWidth <= width)) {
				nextRow();
				text = text.replace(/^\s+/u, "");
				continue;
			}
			const chunk = sliceByColumn(text, 0, available, true);
			if (!chunk) {
				nextRow();
				continue;
			}
			rows.at(-1)!.push({ ...piece, text: chunk });
			const chunkWidth = visibleWidth(chunk);
			text = sliceByColumn(text, chunkWidth, textWidth - chunkWidth, true);
			used += chunkWidth;
		}
	}
	for (const row of rows) {
		const last = row.at(-1);
		if (!last || !/^\s+$/u.test(last.text)) continue;
		last.text = last.text.trimEnd();
		if (!last.text) row.pop();
	}
	return rows;
}
