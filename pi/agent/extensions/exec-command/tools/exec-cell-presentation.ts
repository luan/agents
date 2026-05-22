import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ShellAction, summarizeShellCommand } from "../shell/summary.ts";
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
	renderGroupedExecCommandCall,
	renderOutputBlock,
	renderSpawnedBackgroundTerminalCall,
	renderUserExecCommandCall,
	renderWriteStdinCall,
} from "./exec-cell-rendering-internal.ts";
import type { ExecCommandStatus } from "./exec-command-state.ts";

export type { RenderOutputBlockOptions, RenderTheme } from "./exec-cell-rendering-internal.ts";

export type ExecCellKind = "command" | "exploration" | "spawned-background-terminal" | "user-command" | "write-stdin";

export interface ExecCellOutputBlock {
	output: string;
	footer?: string;
	options?: RenderOutputBlockOptions;
}

export interface ExecCell {
	kind: ExecCellKind;
	status: ExecCommandStatus;
	command?: string;
	actionGroups?: ShellAction[][];
	failed?: boolean;
	elapsedMs?: number;
	rtkWrapped?: boolean;
	contextGuardWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
	writeStdin?: {
		sessionId: number | string;
		input?: string;
		stdinOpen?: boolean;
	};
}

export interface RawCommandToExecCellInput {
	command: string;
	status: ExecCommandStatus;
	failed?: boolean;
	elapsedMs?: number;
	rtkWrapped?: boolean;
	contextGuardWrapped?: boolean;
	outputBlock?: ExecCellOutputBlock;
}

export interface RenderExecCellEnv {
	theme: RenderTheme;
	part?: "header" | "output" | "full";
	width?: number;
	expanded?: boolean;
}

export interface BackgroundTerminalHudCell {
	id?: number | string;
	command?: string;
	output: string;
	elapsedMs?: number;
	startedAtMs?: number;
	nowMs?: number;
	stdinOpen?: boolean;
}

export function rawCommandToExecCell(input: RawCommandToExecCellInput): ExecCell {
	const summary = summarizeShellCommand(input.command);
	if (summary.maskAsExplored) {
		return {
			kind: "exploration",
			status: input.status,
			command: input.command,
			actionGroups: [summary.actions],
			failed: input.failed,
			elapsedMs: input.elapsedMs,
			rtkWrapped: input.rtkWrapped,
			contextGuardWrapped: input.contextGuardWrapped,
			outputBlock: input.outputBlock,
		};
	}
	return {
		kind: "command",
		status: input.status,
		command: input.command,
		failed: input.failed,
		elapsedMs: input.elapsedMs,
		rtkWrapped: input.rtkWrapped,
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

export function renderExecCellComponent(cell: ExecCell, env: RenderExecCellEnv): Component {
	return new ExecCellComponent(cell, env);
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

class ExecCellComponent implements Component {
	private renderedCache?: {
		width: number;
		lines: string[];
	};

	constructor(
		private readonly cell: ExecCell,
		private readonly env: RenderExecCellEnv,
	) {}

	invalidate() {
		this.renderedCache = undefined;
	}

	render(width: number): string[] {
		if (this.cell.status !== "running" && this.renderedCache?.width === width) {
			return this.renderedCache.lines;
		}
		const lines = new Text(renderExecCell(this.cell, { ...this.env, width }), 0, 0).render(width);
		if (this.cell.status !== "running") {
			this.renderedCache = { width, lines };
		}
		return lines;
	}
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
	const tty = cell.stdinOpen
		? `${theme.fg("dim", " · ")}${theme.fg("mdLink", formatStdinCapability(cell.stdinOpen))}`
		: "";
	const lines = outputLineCount(cell.output);
	const outputSummary = lines > 0 ? `(${lines} ${lines === 1 ? "line" : "lines"})` : "(no output)";
	const lastLine = lastOutputLine(cell.output)
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim();
	const command = (cell.command ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
	const last = lastLine ? `${theme.fg("dim", " · ")}${theme.fg("dim", lastLine)}` : "";
	const fixed = `${prefix}${theme.fg("dim", " · ")}${theme.fg("dim", elapsed)}${tty}${theme.fg(
		"dim",
		" · ",
	)}${theme.fg("muted", outputSummary)}${last}${theme.fg("dim", " · ")}`;
	const commandWidth = Math.max(8, width - visibleWidth(fixed));
	const text = `${fixed}${theme.fg("muted", truncateToWidth(command, commandWidth, "..."))}`;
	return visibleWidth(text) > width ? truncateToWidth(text, width, "...") : text;
}

function renderExecCellHeader(cell: ExecCell, theme: RenderTheme): string {
	switch (cell.kind) {
		case "exploration":
			return renderGroupedExecCommandCall(
				cell.actionGroups ?? [],
				cell.status,
				theme,
				cell.failed,
				cell.elapsedMs,
				cell.rtkWrapped,
				cell.contextGuardWrapped,
			);
		case "spawned-background-terminal":
			return renderSpawnedBackgroundTerminalCall(
				cell.command ?? "",
				theme,
				cell.rtkWrapped,
				cell.contextGuardWrapped,
			);
		case "user-command":
			return renderUserExecCommandCall(cell.command ?? "", cell.status, theme, cell.failed, cell.elapsedMs);
		case "write-stdin":
			return renderWriteStdinCall(
				cell.writeStdin?.sessionId ?? "?",
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
				cell.rtkWrapped,
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
