import { Container } from "@earendil-works/pi-tui";
import { approxTokenCount } from "../../shared/output-budget.ts";
import { resolveRuntimeShell } from "../adapter/runtime-shell.ts";
import { type RenderTheme, rawCommandToExecCell, renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { ExecCommandRenderInfo } from "./exec-command-state.ts";
import type { UnifiedExecResult } from "./exec-session-manager.ts";

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function displayCommand(args: { cmd?: unknown }): string {
	return typeof args.cmd === "string" ? args.cmd : "";
}

function displayShell(args: unknown): string {
	const requested =
		args && typeof args === "object" && typeof (args as Record<string, unknown>).shell === "string"
			? (args as Record<string, string>).shell
			: process.env.SHELL;
	return resolveRuntimeShell(requested);
}

function createEmptyResultComponent(): Container {
	return new Container();
}

interface ExecCommandRenderContextLike {
	toolCallId?: string;
	invalidate?: () => void;
	args?: unknown;
	expanded?: boolean;
	isError?: boolean;
	isPartial?: boolean;
	lastComponent?: unknown;
}

export interface ExecCommandSessionSnapshot {
	command?: string;
	output?: string;
	running?: boolean;
	exitCode?: number;
	elapsedMs?: number;
	outputTruncated?: boolean;
	originalTokenCount?: number;
}

export interface ExecCommandPresentationState {
	getRenderInfo(toolCallId: string | undefined, command: string): ExecCommandRenderInfo;
	getSessionSnapshot(sessionId: number): ExecCommandSessionSnapshot | undefined;
}

export interface ExecCommandPresentationIntents {
	registerRenderContext(toolCallId: string | undefined, invalidate: () => void): void;
}

const renderExecCommandCallWithOptionalContext: any = (
	args: { cmd?: unknown },
	theme: RenderTheme,
	context: ExecCommandRenderContextLike | undefined,
	state: ExecCommandPresentationState,
	intents: ExecCommandPresentationIntents,
) => {
	const command = displayCommand(args);
	const shell = displayShell(args);
	if (context?.invalidate) intents.registerRenderContext(context.toolCallId, context.invalidate);
	const renderInfo = state.getRenderInfo(context?.toolCallId, command);
	const failed = context?.isError === true;
	if (context?.isPartial === false && renderInfo.sessionId === undefined) {
		return createEmptyResultComponent();
	}
	const resolveCell = () => {
		const current = state.getRenderInfo(context?.toolCallId, command);
		if (current.sessionId !== undefined) {
			const currentSnapshot = state.getSessionSnapshot(current.sessionId);
			const sessionCommand = currentSnapshot?.command ?? command;
			const running = currentSnapshot?.running ?? current.status === "running";
			const exitCode = currentSnapshot?.exitCode;
			return {
				kind: "terminal-logs" as const,
				status: running ? ("running" as const) : ("done" as const),
				command: sessionCommand,
				shell,
				failed: exitCode !== undefined && exitCode !== 0,
				captureWrapped: current.captureWrapped,
				terminalSession: {
					operation: "logs" as const,
					processId: current.sessionId,
					running,
					exitCode,
					elapsedMs: currentSnapshot?.elapsedMs,
				},
				outputBlock: {
					output: currentSnapshot?.output ?? current.output ?? "",
					options: {
						expanded: false,
						maxLines: 8,
						truncatedAbove: currentSnapshot?.outputTruncated,
						originalTokenCount: running ? undefined : currentSnapshot?.originalTokenCount,
					},
				},
			};
		}
		return rawCommandToExecCell({
			command,
			shell,
			status: current.status,
			failed,
			elapsedMs: current.elapsedMs,
			captureWrapped: current.captureWrapped,
			outputBlock:
				current.output === undefined
					? undefined
					: {
							output: current.output,
							options: { expanded: context?.expanded, maxLines: 8 },
						},
		});
	};
	return renderExecCellComponent(resolveCell(), { theme, resolveCell }, context?.lastComponent);
};

const renderExecCommandResultWithOptionalContext: any = (
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial: boolean },
	theme: RenderTheme,
	context: ExecCommandRenderContextLike | undefined,
	state: ExecCommandPresentationState,
) => {
	const command = context && "args" in context && context.args ? displayCommand((context as any).args) : undefined;
	const shell = displayShell(context?.args);
	const renderInfo = state.getRenderInfo(context?.toolCallId, command ?? "");
	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	// Count the tool result, not the terminal buffer: for a backgrounded command
	// the buffer is the whole transcript while the result is only a launch
	// acknowledgement, so counting the buffer bills this call for tokens that
	// the later `write_stdin` polls actually paid.
	const resultText = result.content.find((item) => item.type === "text");
	const deliveredTokens =
		resultText?.type === "text" && resultText.text ? approxTokenCount(resultText.text) : undefined;
	if (renderInfo.sessionId !== undefined) return createEmptyResultComponent();
	const failed =
		context?.isError === true ||
		(details?.exit_code !== undefined && details.exit_code !== 0) ||
		details?.cancelled === true ||
		details?.terminal_state === "session_error";
	if (details?.process_id !== undefined) {
		return renderExecCellComponent(
			{
				kind: "terminal-logs",
				status: "done",
				command: command ?? "",
				shell,
				failed,
				contextTokens: deliveredTokens,
				captureWrapped: renderInfo.captureWrapped,
				terminalSession: {
					operation: "logs",
					processId: details.process_id,
					exitCode: details.exit_code,
				},
				outputBlock: {
					output: details.output,
					options: {
						expanded: false,
						maxLines: 8,
						truncatedAbove: details.output_truncated,
						originalTokenCount: details.original_token_count,
					},
				},
			},
			{ theme, expanded: options.expanded },
			context?.lastComponent,
		);
	}

	const content = result.content.find((item) => item.type === "text");
	const output = details?.output ?? (content?.type === "text" ? content.text : "");
	return renderExecCellComponent(
		rawCommandToExecCell({
			command: command ?? "",
			shell,
			status: renderInfo.status,
			elapsedMs: details?.wall_time_seconds === undefined ? undefined : Math.round(details.wall_time_seconds * 1000),
			failed,
			exitCode: details?.exit_code,
			captureWrapped: renderInfo.captureWrapped,
			contextTokens: deliveredTokens,
			outputBlock: {
				output: output ?? "",
				options: {
					expanded: options.expanded,
					maxLines: 8,
					truncatedAbove: details?.output_truncated,
					originalTokenCount: details?.original_token_count,
				},
			},
		}),
		{ theme, expanded: options.expanded },
		context?.lastComponent,
	);
};

export function createExecCommandPresentation(
	state: ExecCommandPresentationState,
	intents: ExecCommandPresentationIntents,
) {
	return {
		renderShell: "self" as const,
		rendersOwnFailure: true,
		renderCall: ((args: { cmd?: unknown }, theme: RenderTheme, context?: ExecCommandRenderContextLike) =>
			renderExecCommandCallWithOptionalContext(args, theme, context, state, intents)) as any,
		renderResult: ((
			result: { content: Array<{ type: string; text?: string }>; details?: unknown },
			renderOptions: { expanded: boolean; isPartial: boolean },
			theme: RenderTheme,
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandResultWithOptionalContext(result, renderOptions, theme, context, state)) as any,
	};
}
