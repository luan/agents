import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	sanitizeTuiTextPreview,
	type TuiActivityIndicatorStyle,
	type TuiForegroundColor,
	type TuiTextEffectStyle,
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
	indicatorStyle: TuiActivityIndicatorStyle;
	textEffectStyle: TuiTextEffectStyle;
	textEffectScope: NonNullable<ActivityAnimationOverrides["textEffectScope"]>;
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
	private pieces: readonly ShellPiece[] = [];
	private piecesCommand: string | undefined;
	private piecesShell: string | undefined;
	private piecesMaximumCharacters = 0;
	private disposed = false;
	private syntaxReadyRequested = false;

	constructor(private readonly options: ShellCommandActionOptions) {
		this.view = options.view;
		this.running = options.view.running ?? options.view.status === "running";
		this.syncMotion();
	}

	update(view: ShellCommandActionView, running = view.running ?? view.status === "running"): void {
		if (!this.running && running) this.startedAt = performance.now();
		if (view.command !== this.view.command || view.shell !== this.view.shell) {
			this.piecesCommand = undefined;
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
		const indicatorStyle = this.options.animation?.indicatorStyle ?? appearance.activityIndicator;
		const textEffectStyle = this.options.animation?.textEffectStyle ?? appearance.textEffect;
		const activity = this.running
			? {
					...this.options.animation,
					elapsedMs: this.now - this.startedAt,
					indicatorStyle: this.options.reducedMotion && indicatorStyle !== "off" ? ("static" as const) : indicatorStyle,
					textEffectStyle: this.options.reducedMotion ? ("off" as const) : textEffectStyle,
					textEffectScope: this.options.animation?.textEffectScope ?? appearance.textEffectScope,
					animationSpeed: this.options.animation?.animationSpeed ?? appearance.animationSpeed,
				}
			: undefined;
		const key = `${this.revision}\0${activity?.indicatorStyle ?? ""}\0${activity?.textEffectStyle ?? ""}\0${activity?.textEffectScope ?? ""}\0${activity?.animationSpeed ?? ""}\0${activity?.elapsedMs ?? ""}`;
		return this.cache.get(boundedWidth, key, () =>
			renderShellCommand(
				this.options.theme,
				this.view,
				boundedWidth,
				activity,
				this.commandPieces(boundedWidth),
				this.options.maxRows,
			),
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
			this.piecesCommand = undefined;
			this.cache.clear();
			this.options.requestRender();
		});
	}

	private commandPieces(width: number): readonly ShellPiece[] {
		const rows = Math.max(1, Math.floor(this.options.maxRows ?? 6));
		// The header cannot reveal more cells. Increase the source budget only if the header becomes expandable.
		const maximumCharacters = Math.max(1, width * rows + 1);
		if (
			this.piecesCommand === this.view.command &&
			this.piecesShell === this.view.shell &&
			this.piecesMaximumCharacters === maximumCharacters
		) {
			return this.pieces;
		}
		this.pieces = shellPieces(this.view.command, this.view.shell, maximumCharacters);
		this.piecesCommand = this.view.command;
		this.piecesShell = this.view.shell;
		this.piecesMaximumCharacters = maximumCharacters;
		return this.pieces;
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
	pieces: readonly ShellPiece[],
	maxRows = 6,
): string[] {
	const colors = tuiTheme(theme);
	const promptTone = view.status === "failed" ? "negative" : view.status === "queued" ? "text.muted" : "positive";
	if (width <= 2) return [colors.fg(promptTone, truncateToWidth("$ ", width, ""))];
	const activityIndicator = activity
		? activityFrame(colors, "", activity.elapsedMs, {
				indicatorStyle: activity.indicatorStyle,
				textEffectStyle: activity.textEffectStyle,
				textEffectScope: activity.textEffectScope,
				animationSpeed: activity.animationSpeed,
			}).marker
		: "";
	const prefix = `${activityIndicator ? `${activityIndicator} ` : ""}${colors.fg(promptTone, "$")} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const limit = Math.max(1, Math.floor(maxRows));
	const rows = wrapPieces(pieces, contentWidth, limit);
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
		if (activity && activityAnimatesText(activity.textEffectStyle)) {
			const text = row.map((piece) => piece.text).join("");
			return `${lead}${
				activityFrame(colors, text, activity.elapsedMs + index * 70, {
					indicatorStyle: activity.indicatorStyle,
					textEffectStyle: activity.textEffectStyle,
					textEffectScope: activity.textEffectScope,
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

function shellPieces(command: string, shell?: string, maximumCharacters = Number.POSITIVE_INFINITY): ShellPiece[] {
	const source = sanitizeTuiTextPreview(command, maximumCharacters);
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

function wrapPieces(pieces: readonly ShellPiece[], width: number, rowLimit = Number.POSITIVE_INFINITY): ShellPiece[][] {
	const rows: ShellPiece[][] = [[]];
	let used = 0;
	const nextRow = () => {
		rows.push([]);
		used = 0;
		return rows.length > rowLimit;
	};
	const finish = () => {
		for (const row of rows) {
			const last = row.at(-1);
			if (!last || !/^\s+$/u.test(last.text)) continue;
			last.text = last.text.trimEnd();
			if (!last.text) row.pop();
		}
		return rows;
	};
	for (const piece of pieces) {
		if (piece.text === "\n") {
			if (nextRow()) return finish();
			continue;
		}
		let text = used === 0 ? piece.text.replace(/^\s+/u, "") : piece.text;
		while (text.length > 0) {
			const available = width - used;
			if (available <= 0) {
				if (nextRow()) return finish();
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
				if (nextRow()) return finish();
				text = text.replace(/^\s+/u, "");
				continue;
			}
			const chunk = sliceByColumn(text, 0, available, true);
			if (!chunk) {
				if (nextRow()) return finish();
				continue;
			}
			rows.at(-1)!.push({ ...piece, text: chunk });
			const chunkWidth = visibleWidth(chunk);
			text = sliceByColumn(text, chunkWidth, textWidth - chunkWidth, true);
			used += chunkWidth;
		}
	}
	return finish();
}
