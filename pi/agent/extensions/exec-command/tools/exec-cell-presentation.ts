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
	elapsedMs?: number;
	contextGuardWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
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
	elapsedMs?: number;
	contextGuardWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
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
		elapsedMs: input.elapsedMs,
		contextGuardWrapped: input.contextGuardWrapped,
		outputBlock: input.outputBlock,
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

const MAX_CACHED_RENDER_TEXT_LENGTH = 16_384;

function shouldCacheRenderedLines(cell: ExecCell, text: string): boolean {
	return (
		!cell.outputBlock ||
		(cell.outputBlock.output.length <= MAX_CACHED_RENDER_TEXT_LENGTH && text.length <= MAX_CACHED_RENDER_TEXT_LENGTH)
	);
}

class ExecCellComponent implements Component {
	private renderedCache?: {
		width: number;
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
		// The cache has to sit in front of renderExecCell(): shell tokenizing, syntax
		// highlighting and output limiting all happen in there, and render() is called on
		// every animation frame.
		if (this.renderedCache?.width === width && !this.env.resolveCell) return this.renderedCache.lines;
		if (this.env.resolveCell) this.cell = this.env.resolveCell();
		if (this.cell.kind === "spawned-background-terminal" || this.cell.kind === "terminal-wait") {
			const text = renderExecCellHeader(this.cell, this.env.theme).replace(/\s*\n\s*/g, " ");
			const lines = [truncateToWidthCompat(text, width, "...")];
			this.renderedCache = { width, lines };
			return lines;
		}
		const innerWidth = Math.max(1, width - 3);
		const shellCard = this.cell.kind === "command" || this.cell.kind === "terminal-logs";
		const renderedHeader = shellCard
			? renderShellCardHeader(
					this.cell.shell,
					this.cell.status,
					this.env.theme,
					this.cell.failed,
					this.cell.elapsedMs ?? this.cell.terminalSession?.elapsedMs,
					this.cell.terminalSession?.processId,
				)
			: renderExecCellHeader(this.cell, this.env.theme);
		const commandLines = shellCard
			? renderTerminalCommandHeader(
					this.cell.command ?? "",
					this.cell.status,
					this.env.theme,
					this.cell.failed,
					this.cell.elapsedMs,
					this.cell.contextGuardWrapped,
				).split("\n")
			: renderedHeader.split("\n");
		const outputLines = this.cell.outputBlock
			? renderTerminalOutputLines(this.cell.outputBlock.output, this.env.theme, this.cell.outputBlock.footer, {
					...this.cell.outputBlock.options,
					expanded: this.env.expanded ?? this.cell.outputBlock.options?.expanded,
					width: innerWidth,
				})
			: [];
		const lines = framedBlock(this.env.theme, {
			header: shellCard ? renderedHeader : "",
			sections: [
				{ lines: commandLines },
				...(outputLines.length > 0
					? [{ label: this.env.theme.fg("toolTitle", "Output"), lines: outputLines }]
					: []),
			],
			borderColor: this.cell.failed ? "error" : this.cell.status === "running" ? "accent" : "dim",
		}).render(width);
		this.renderedCache = shouldCacheRenderedLines(this.cell, renderedHeader) ? { width, lines } : undefined;
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

function renderExecCellHeader(cell: ExecCell, theme: RenderTheme): string {
	switch (cell.kind) {
		case "spawned-background-terminal":
			return renderSpawnedBackgroundTerminalCall(
				cell.command ?? "",
				theme,
				cell.contextGuardWrapped,
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
				cell.contextGuardWrapped,
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
