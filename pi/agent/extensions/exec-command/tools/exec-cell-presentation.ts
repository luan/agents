import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidthCompat } from "../../shared/tui";
import { framedBlock } from "../../shared/tui/card.ts";
import {
	backgroundTerminalAnimatedLabel,
	backgroundTerminalPulseMarker,
	formatElapsedTime,
	formatStdinCapability,
	lastOutputLine,
	outputLineCount,
	type RenderOutputBlockOptions,
	type RenderTheme,
	renderBackgroundTerminalHudLine,
	renderExecCommandCall,
	renderOutputBlock,
	renderShellCardHeader,
	renderSpawnedBackgroundTerminalCall,
	renderTerminalCommandHeader,
	renderTerminalOutputLines,
	renderTerminalSessionRow,
	renderUserExecCommandCall,
	renderWriteStdinCall,
	type TerminalSessionView,
} from "./exec-cell-rendering-internal.ts";
import type { ExecCommandStatus } from "./exec-command-state.ts";

export type { RenderOutputBlockOptions, RenderTheme } from "./exec-cell-rendering-internal.ts";

const WIDTH_CACHE_LIMIT = 512;
const widthCache = new Map<string, number>();
const truncationCache = new Map<string, string>();

function cacheValue<T>(cache: Map<string, T>, key: string, value: () => T): T {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	if (cache.size >= WIDTH_CACHE_LIMIT) cache.clear();
	const next = value();
	cache.set(key, next);
	return next;
}

function cachedVisibleWidth(text: string): number {
	return cacheValue(widthCache, text, () => visibleWidth(text));
}

function cachedTruncate(text: string, width: number): string {
	return cacheValue(truncationCache, `${width}\0${text}`, () => truncateToWidthCompat(text, width, "..."));
}

type ExecCellKind =
	| "command"
	| "spawned-background-terminal"
	| "terminal-logs"
	| "terminal-wait"
	| "user-command"
	| "write-stdin";

interface ExecCellOutputBlock {
	output: string;
	footer?: string;
	options?: RenderOutputBlockOptions;
}

interface ExecCell {
	kind: ExecCellKind;
	status: ExecCommandStatus;
	command?: string;
	shell?: string;
	failed?: boolean;
	/** Shown on the shell-card header rather than in the Output body, where it read as command output. */
	exitCode?: number;
	elapsedMs?: number;
	captureWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
	/**
	 * Tokens the tool result actually contributed to the context.
	 *
	 * Deliberately not derived from `outputBlock.output`: that is the terminal
	 * buffer drawn in the TUI, which for a backgrounded command is the whole
	 * transcript while the tool result is only a launch acknowledgement. Those
	 * differ by orders of magnitude, and reporting the buffer would attribute
	 * cost to a call that never paid it.
	 */
	contextTokens?: number;
	terminalSession?: TerminalSessionView;
	writeStdin?: {
		processId: number | string;
		input?: string;
		stdinOpen?: boolean;
	};
}

interface RawCommandToExecCellInput {
	command: string;
	shell?: string;
	status: ExecCommandStatus;
	failed?: boolean;
	exitCode?: number;
	elapsedMs?: number;
	captureWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
	contextTokens?: number;
}

interface RenderExecCellEnv {
	theme: RenderTheme;
	part?: "header" | "output" | "full";
	width?: number;
	expanded?: boolean;
	resolveCell?: () => ExecCell;
}

interface BackgroundTerminalHudCell {
	id?: number | string;
	command?: string;
	output: string;
	elapsedMs?: number;
	lineCount?: number;
	lastLine?: string;
	startedAtMs?: number;
	nowMs?: number;
	stdinOpen?: boolean;
}

export function rawCommandToExecCell(input: RawCommandToExecCellInput): ExecCell {
	return {
		kind: "command",
		status: input.status,
		command: input.command,
		shell: input.shell,
		failed: input.failed,
		exitCode: input.exitCode,
		elapsedMs: input.elapsedMs,
		captureWrapped: input.captureWrapped,
		outputBlock: input.outputBlock,
		contextTokens: input.contextTokens,
	};
}

export function renderExecCell(cell: ExecCell, env: RenderExecCellEnv): string {
	const part = env.part ?? "full";
	if (part === "output") return renderExecCellOutput(cell, env);
	const header = renderExecCellHeader(cell, env.theme);
	if (part === "header") return header;
	const output = renderExecCellOutput(cell, env);
	return output ? `${header}\n${output}` : header;
}

export function renderExecCellComponent(cell: ExecCell, env: RenderExecCellEnv, previous?: unknown): Component {
	if (previous instanceof ExecCellComponent) {
		previous.update(cell, env);
		return previous;
	}
	return new ExecCellComponent(cell, env);
}

function sameRenderKey(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
	return left?.length === right.length && left.every((value, index) => value === right[index]);
}

class ExecCellComponent implements Component {
	private renderedCache?: {
		width: number;
		key?: readonly unknown[];
		lines: string[];
	};

	constructor(
		private cell: ExecCell,
		private env: RenderExecCellEnv,
	) {}

	update(cell: ExecCell, env: RenderExecCellEnv) {
		// Callers hand over a freshly built cell whenever anything changed, so identity is
		// the change signal — and the only thing that may invalidate rendered lines.
		if (cell !== this.cell || env !== this.env) this.renderedCache = undefined;
		this.cell = cell;
		this.env = env;
	}

	invalidate() {
		this.renderedCache = undefined;
	}

	render(width: number): string[] {
		// Resolve live sessions before checking the cache. Most animation frames change
		// neither their formatted header nor their output, so the expensive ANSI layout
		// stays cached while session polling remains live.
		if (this.env.resolveCell) this.cell = this.env.resolveCell();
		else if (this.renderedCache?.width === width) return this.renderedCache.lines;
		if (this.cell.kind === "spawned-background-terminal" || this.cell.kind === "terminal-wait") {
			const text = renderExecCellHeader(this.cell, this.env.theme).replace(/\s*\n\s*/g, " ");
			const key = [text];
			if (this.renderedCache?.width === width && sameRenderKey(this.renderedCache.key, key)) {
				return this.renderedCache.lines;
			}
			const lines = [truncateToWidthCompat(text, width, "...")];
			this.renderedCache = { width, key, lines };
			return lines;
		}
		const innerWidth = Math.max(1, width - 3);
		const part = this.env.part ?? "full";
		const shellCard = this.cell.kind === "command" || this.cell.kind === "terminal-logs";
		const renderedHeader = shellCard
			? renderShellCardHeader(
					this.cell.shell,
					this.cell.status,
					this.env.theme,
					this.cell.failed,
					this.cell.elapsedMs ?? this.cell.terminalSession?.elapsedMs,
					this.cell.terminalSession?.processId,
					completedOutputTokens(this.cell),
					this.cell.exitCode ?? this.cell.terminalSession?.exitCode,
				)
			: renderExecCellHeader(this.cell, this.env.theme);
		// `part: "output"` draws the block under a header row another render already
		// printed. Ignoring it repeated the write_stdin title, with `#?` where the
		// process id would be: an output-only cell carries no `writeStdin` field.
		const commandLines =
			part === "output"
				? []
				: shellCard
					? renderTerminalCommandHeader(
							this.cell.command ?? "",
							this.cell.status,
							this.env.theme,
							this.cell.failed,
							this.cell.elapsedMs,
							this.cell.captureWrapped,
						).split("\n")
					: renderedHeader.split("\n");
		const options = this.cell.outputBlock?.options;
		const cacheKey = [
			part,
			renderedHeader,
			commandLines.join("\n"),
			this.cell.outputBlock?.output,
			this.cell.outputBlock?.footer,
			this.env.expanded,
			options?.expanded,
			options?.maxLines,
			options?.truncatedAbove,
			options?.originalTokenCount,
			this.cell.failed,
			this.cell.status,
		];
		if (this.renderedCache?.width === width && sameRenderKey(this.renderedCache.key, cacheKey)) {
			return this.renderedCache.lines;
		}
		const outputLines =
			this.cell.outputBlock && part !== "header"
				? renderTerminalOutputLines(this.cell.outputBlock.output, this.env.theme, this.cell.outputBlock.footer, {
						...options,
						expanded: this.env.expanded ?? options?.expanded,
						width: innerWidth,
					})
				: [];
		const lines = framedBlock(this.env.theme, {
			header: shellCard ? renderedHeader : "",
			sections: [
				...(commandLines.length > 0 ? [{ lines: commandLines }] : []),
				...(outputLines.length > 0
					? [{ label: this.env.theme.fg("toolTitle", "Output"), lines: outputLines }]
					: []),
			],
			borderColor: this.cell.failed ? "error" : this.cell.status === "running" ? "accent" : "dim",
		}).render(width);
		this.renderedCache = { width, key: cacheKey, lines };
		return lines;
	}
}

export function renderBackgroundTerminalHud(
	cell: BackgroundTerminalHudCell,
	env: { theme: RenderTheme; width?: number },
): string {
	if (cell.id !== undefined && cell.startedAtMs !== undefined) {
		return renderBackgroundTerminalWidgetLine(cell, env);
	}
	return renderBackgroundTerminalHudLine(
		cell.command,
		cell.output,
		env.theme,
		cell.elapsedMs ?? 0,
		env.width,
		cell.stdinOpen,
	);
}

function renderBackgroundTerminalWidgetLine(
	cell: BackgroundTerminalHudCell,
	env: { theme: RenderTheme; width?: number },
): string {
	const theme = env.theme;
	const width = env.width ?? 120;
	const elapsedMs = (cell.nowMs ?? Date.now()) - (cell.startedAtMs ?? cell.nowMs ?? Date.now());
	const elapsed = formatElapsedTime(elapsedMs);
	const prefix = `${backgroundTerminalPulseMarker(theme, elapsedMs)} ${backgroundTerminalAnimatedLabel(theme, elapsedMs)} ${theme.fg(
		"muted",
		`#${cell.id}`,
	)}`;
	const ttyLabel = cell.stdinOpen ? formatStdinCapability(cell.stdinOpen) : undefined;
	const tty = ttyLabel ? `${theme.fg("dim", " · ")}${theme.fg("mdLink", ttyLabel)}` : "";
	const lines = cell.lineCount ?? outputLineCount(cell.output);
	const outputSummary = lines > 0 ? `(${lines} ${lines === 1 ? "line" : "lines"})` : "(no output)";
	const lastLine = (cell.lastLine ?? lastOutputLine(cell.output))?.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const command = (cell.command ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const last = lastLine ? `${theme.fg("dim", " · ")}${theme.fg("dim", lastLine)}` : "";
	const fixed = `${prefix}${theme.fg("dim", " · ")}${theme.fg("dim", elapsed)}${tty}${theme.fg(
		"dim",
		" · ",
	)}${theme.fg("muted", outputSummary)}${last}${theme.fg("dim", " · ")}`;
	const fixedVisibleWidth =
		1 +
		1 +
		"background terminal".length +
		1 +
		`#${cell.id}`.length +
		3 +
		elapsed.length +
		(ttyLabel ? 3 + cachedVisibleWidth(ttyLabel) : 0) +
		3 +
		outputSummary.length +
		(lastLine ? 3 + cachedVisibleWidth(lastLine) : 0) +
		3;
	const commandWidth = Math.max(8, width - fixedVisibleWidth);
	const renderedCommand = cachedTruncate(command, commandWidth);
	const text = `${fixed}${theme.fg("muted", renderedCommand)}`;
	return fixedVisibleWidth + cachedVisibleWidth(renderedCommand) > width
		? truncateToWidthCompat(text, width, "...")
		: text;
}

/**
 * Token cost of a finished cell, for the completion header.
 *
 * Running cells report nothing: the cost is not settled yet, and counting on
 * every animation frame would pay for a number that keeps changing.
 */
function completedOutputTokens(cell: ExecCell): number | undefined {
	if (cell.status === "running") return undefined;
	return cell.contextTokens;
}

function renderExecCellHeader(cell: ExecCell, theme: RenderTheme): string {
	switch (cell.kind) {
		case "spawned-background-terminal":
			return renderSpawnedBackgroundTerminalCall(
				cell.command ?? "",
				theme,
				cell.captureWrapped,
				cell.terminalSession,
			);
		case "terminal-logs":
		case "terminal-wait":
			return renderTerminalSessionRow(cell.terminalSession!, theme);
		case "user-command":
			return renderUserExecCommandCall(cell.command ?? "", cell.status, theme, cell.failed, cell.elapsedMs);
		case "write-stdin":
			return renderWriteStdinCall(
				cell.writeStdin?.processId ?? "?",
				cell.writeStdin?.input,
				cell.command,
				theme,
				cell.status,
				cell.failed,
				cell.elapsedMs,
				cell.writeStdin?.stdinOpen,
			);
		case "command":
			return renderExecCommandCall(
				cell.command ?? "",
				cell.status,
				theme,
				cell.failed,
				cell.elapsedMs,
				cell.captureWrapped,
			);
	}
}

function renderExecCellOutput(cell: ExecCell, env: RenderExecCellEnv): string {
	if (!cell.outputBlock) return "";
	return renderOutputBlock(cell.outputBlock.output, env.theme, cell.outputBlock.footer, {
		...cell.outputBlock.options,
		expanded: env.expanded ?? cell.outputBlock.options?.expanded,
		width: env.width ?? cell.outputBlock.options?.width,
	});
}
