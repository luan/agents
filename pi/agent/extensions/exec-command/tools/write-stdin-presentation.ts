import { Container } from "@earendil-works/pi-tui";
import { runningCellElapsedMs, sharedAnimationRenderAllowed, shouldAnimateRunningCell } from "../../shared/tui";
import { type RenderTheme, renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { UnifiedExecResult } from "./exec-session-manager.ts";

interface FormattedExecTranscript {
	output: string;
	processId?: number;
	exitCode?: number;
	stdinOpen?: boolean;
	originalTokenCount?: number;
	outputTruncated?: boolean;
}

function parseFormattedExecTranscript(text: string): FormattedExecTranscript {
	const marker = "\nOutput:\n";
	const markerIndex = text.indexOf(marker);
	const output = markerIndex !== -1 ? text.slice(markerIndex + marker.length) : text;
	const processMatch = text.match(/Process running with process ID (\d+)/);
	const exitCodeMatch = text.match(/Process exited with code (-?\d+)/);
	const stdinMatch = text.match(/Stdin: (open|closed)/);
	const ttyMatch = text.match(/TTY: yes/);
	return {
		output,
		processId: processMatch ? Number(processMatch[1]) : undefined,
		exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : undefined,
		stdinOpen: ttyMatch ? true : stdinMatch ? stdinMatch[1] === "open" : undefined,
	};
}

function renderTerminalText(text: string): string {
	let committed = "";
	let line: string[] = [];
	let cursor = 0;

	for (const char of text) {
		switch (char) {
			case "\r":
				cursor = 0;
				break;
			case "\n":
				committed += `${line.join("")}\n`;
				line = [];
				cursor = 0;
				break;
			case "\b":
				cursor = Math.max(0, cursor - 1);
				break;
			default:
				if (cursor > line.length) {
					line.push(...Array.from({ length: cursor - line.length }, () => " "));
				}
				line[cursor] = char;
				cursor += 1;
				break;
		}
	}

	return committed + line.join("");
}

function getResultState(result: {
	details?: unknown;
	content: Array<{ type: string; text?: string }>;
}): FormattedExecTranscript {
	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	const content = result.content.find((item) => item.type === "text");
	if (details) {
		return {
			output: details.output,
			processId: details.process_id,
			exitCode: details.exit_code,
			stdinOpen: details.stdin_open,
			originalTokenCount: details.original_token_count,
			outputTruncated: details.output_truncated,
		};
	}
	if (content?.type === "text") {
		return parseFormattedExecTranscript(content.text ?? "");
	}
	return { output: "" };
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyResultComponent(): Container {
	return new Container();
}

const BACKGROUND_TERMINAL_HUD_FRAME_MS = 120;
interface RenderContextLike {
	args?: unknown;
	isError?: boolean;
	isPartial?: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
		startedAtMs?: number;
	};
}

export interface WriteStdinSessionSnapshot {
	command?: string;
	running: boolean;
	stdinOpen?: boolean;
	tty: boolean;
}

export interface WriteStdinPresentationState {
	getSessionSnapshot(sessionId: number): WriteStdinSessionSnapshot | undefined;
}

/**
 * A poll that neither writes nor waits for anything has no story to tell, so it
 * renders nothing. A poll carrying `until` does: it can block for half a minute,
 * and a cell that shows nothing for half a minute reads as a hang.
 */
function isSilentPoll(params: Record<string, unknown> | undefined): boolean {
	if (!params) return true;
	if (typeof params.until === "string" && params.until.length > 0) return false;
	return typeof params.chars !== "string" || params.chars.length === 0;
}

function isSilentPollRenderContext(context: RenderContextLike | undefined): boolean {
	if (!context?.args || typeof context.args !== "object") return false;
	return isSilentPoll(context.args as Record<string, unknown>);
}

function elapsedMs(context: RenderContextLike | undefined, running: boolean): number | undefined {
	return runningCellElapsedMs(context?.state, running);
}

function scheduleRunningInvalidation(context: RenderContextLike | undefined, running: boolean): void {
	const state = context?.state;
	if (!state) return;
	if (!shouldAnimateRunningCell(state, running)) {
		if (state.elapsedTimer) {
			clearTimeout(state.elapsedTimer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (state.elapsedTimer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		if (sharedAnimationRenderAllowed()) context.invalidate?.();
	}, BACKGROUND_TERMINAL_HUD_FRAME_MS);
}

export function createWriteStdinPresentation(state: WriteStdinPresentationState) {
	return {
		renderShell: "self",
		emptyRenderIsFinal: true,
		renderCall(args: Record<string, unknown>, theme: RenderTheme, context?: RenderContextLike) {
			const processId = typeof args.process_id === "number" ? args.process_id : "?";
			const running = context?.isPartial === true;
			if (isSilentPoll(args)) {
				return createEmptyResultComponent();
			}
			scheduleRunningInvalidation(context, running);
			const input = typeof args.chars === "string" ? args.chars : undefined;
			const resolveCell = () => {
				const snapshot = processId !== "?" ? state.getSessionSnapshot(processId) : undefined;
				const stdinOpen = snapshot?.running ? snapshot.stdinOpen : undefined;
				const command = snapshot?.command;
				return {
					kind: "write-stdin" as const,
					status: running ? ("running" as const) : ("done" as const),
					command,
					failed: context?.isError === true,
					elapsedMs: elapsedMs(context, running),
					writeStdin: {
						processId,
						input,
						stdinOpen,
					},
				};
			};
			return renderExecCellComponent(resolveCell(), { theme, part: "header", resolveCell }, context?.lastComponent);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: unknown },
			{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
			theme: RenderTheme,
			context?: RenderContextLike,
		) {
			if (isPartial) return createEmptyResultComponent();
			const transcript = getResultState(result);
			const args =
				context?.args && typeof context.args === "object" ? (context.args as Record<string, unknown>) : undefined;
			const processId = typeof args?.process_id === "number" ? args.process_id : transcript.processId;
			const tty =
				processId !== undefined ? state.getSessionSnapshot(processId)?.tty === true : transcript.stdinOpen === true;
			if (tty) return createEmptyResultComponent();
			if (isSilentPollRenderContext(context)) return createEmptyResultComponent();
			const output = renderTerminalText(transcript.output);
			const footer =
				transcript.processId !== undefined
					? `${theme.fg("accent", `Process ${transcript.processId} still running`)}${
							transcript.stdinOpen ? `${theme.fg("dim", " · ")}${theme.fg("mdLink", "tty")}` : ""
						}`
					: transcript.exitCode !== undefined && transcript.exitCode !== 0
						? theme.fg("muted", `Exit code: ${transcript.exitCode}`)
						: undefined;
			return renderExecCellComponent(
				{
					kind: "write-stdin",
					status: "done",
					outputBlock: {
						output,
						footer,
						options: {
							expanded,
							truncatedAbove: transcript.outputTruncated,
							originalTokenCount: transcript.originalTokenCount,
						},
					},
				},
				{ theme, part: "output" },
				context?.lastComponent,
			);
		},
	};
}
