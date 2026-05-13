import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { summarizeShellCommand } from "../shell/summary.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import {
	renderExecCommandCall,
	renderGroupedExecCommandCall,
	renderOutputBlock,
	renderSpawnedBackgroundTerminalCall,
} from "./exec-rendering.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { commandHasRipgrepSegment, isRtkGrepCommand } from "./rtk-wrapper.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.String({ description: "Shell command to execute." }),
	workdir: Type.Optional(
		Type.String({
			description: "Optional working directory; defaults to the current turn cwd.",
		}),
	),
	shell: Type.Optional(
		Type.String({
			description: "Optional shell binary; defaults to the user's shell.",
		}),
	),
	tty: Type.Optional(
		Type.Boolean({
			description:
				"Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: "How long to wait in milliseconds for output before yielding.",
		}),
	),
	login: Type.Optional(
		Type.Boolean({
			description: "Whether to run the shell with -l/-i semantics. Defaults to true.",
		}),
	),
});

interface ExecCommandParams {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	login?: boolean;
}

type ExecCommandRewrite = string | { command: string; rtkWrapped?: boolean };

interface ExecCommandToolOptions {
	rewriteCommand?: (command: string, ctx: ExtensionContext) => Promise<ExecCommandRewrite> | ExecCommandRewrite;
	onResult?: (
		params: ExecCommandParams,
		result: UnifiedExecResult,
		ctx: ExtensionContext,
	) => { terminate?: boolean } | undefined;
}

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!args || typeof args !== "object") {
		return args as ExecCommandParams;
	}

	const record = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...record };
	if (!("cmd" in prepared) && "command" in prepared) {
		prepared.cmd = prepared.command;
	}
	if (!("workdir" in prepared)) {
		if ("cwd" in prepared) {
			prepared.workdir = prepared.cwd;
		} else if ("working_directory" in prepared) {
			prepared.workdir = prepared.working_directory;
		}
	}
	return prepared as unknown as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") {
		throw new Error("exec_command requires an object parameter");
	}

	const cmd = "cmd" in params ? params.cmd : undefined;
	if (typeof cmd !== "string") {
		throw new Error("exec_command requires a string 'cmd' parameter");
	}

	return {
		cmd,
		workdir: "workdir" in params && typeof params.workdir === "string" ? params.workdir : undefined,
		shell: "shell" in params && typeof params.shell === "string" ? params.shell : undefined,
		tty: "tty" in params && typeof params.tty === "boolean" ? params.tty : undefined,
		yield_time_ms:
			"yield_time_ms" in params && typeof params.yield_time_ms === "number" ? params.yield_time_ms : undefined,
		login: "login" in params && typeof params.login === "boolean" ? params.login : undefined,
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function createEmptyResultComponent(): Container {
	return new Container();
}

class OutputBlockComponent implements Component {
	constructor(
		private readonly output: string,
		private readonly theme: { fg(role: string, text: string): string },
		private readonly footer: string | undefined,
		private readonly options: { expanded: boolean; truncatedAbove?: boolean; originalTokenCount?: number },
	) {}

	invalidate() {}

	render(width: number): string[] {
		return new Text(
			renderOutputBlock(this.output, this.theme, this.footer, {
				...this.options,
				width,
			}),
			0,
			0,
		).render(width);
	}
}

function shouldUseRawRipgrep(originalCommand: string, rewrittenCommand: string): boolean {
	return (
		originalCommand !== rewrittenCommand &&
		commandHasRipgrepSegment(originalCommand) &&
		isRtkGrepCommand(rewrittenCommand)
	);
}

interface ExecCommandRenderContextLike {
	toolCallId?: string;
	invalidate?: () => void;
	args?: unknown;
	isError?: boolean;
	isPartial?: boolean;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
	};
}

const RUNNING_INVALIDATION_MS = 120;

function scheduleElapsedInvalidation(context: ExecCommandRenderContextLike | undefined, running: boolean): void {
	const state = context?.state;
	if (!state) return;
	if (!running) {
		if (state.elapsedTimer) {
			clearTimeout(state.elapsedTimer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (state.elapsedTimer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		context.invalidate?.();
	}, RUNNING_INVALIDATION_MS);
}

const renderExecCommandCallWithOptionalContext: any = (
	args: { cmd?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
) => {
	const command = typeof args.cmd === "string" ? args.cmd : "";
	tracker.ensurePlannedExploration(context?.toolCallId, command);
	tracker.registerRenderContext(context?.toolCallId, context?.invalidate ?? (() => {}));
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command);
	const failed = context?.isError === true;
	const isExplorationRow = renderInfo.actionGroups !== undefined;
	const snapshot = renderInfo.sessionId !== undefined ? sessions.getSessionSnapshot(renderInfo.sessionId) : undefined;
	scheduleElapsedInvalidation(context, !snapshot?.running && !isExplorationRow && renderInfo.status === "running");
	if (renderInfo.hidden) {
		return new Text("", 0, 0);
	}
	if (renderInfo.sessionId !== undefined) {
		const sessionCommand = snapshot?.command ?? sessions.getSessionCommand(renderInfo.sessionId) ?? command;
		return new Text(renderSpawnedBackgroundTerminalCall(sessionCommand, theme, renderInfo.rtkWrapped), 0, 0);
	}
	const text = renderInfo.actionGroups
		? renderGroupedExecCommandCall(
				renderInfo.actionGroups,
				renderInfo.status,
				theme,
				failed,
				renderInfo.elapsedMs,
				renderInfo.rtkWrapped,
			)
		: renderExecCommandCall(command, renderInfo.status, theme, failed, renderInfo.elapsedMs, renderInfo.rtkWrapped);
	return new Text(text, 0, 0);
};

const renderExecCommandResultWithOptionalContext: any = (
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg(role: string, text: string): string },
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
	_sessions: ExecSessionManager,
) => {
	if (options.isPartial) {
		return createEmptyResultComponent();
	}

	const command =
		context && "args" in context && context.args && typeof (context as any).args.cmd === "string"
			? (context as any).args.cmd
			: undefined;
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command ?? "");
	if (renderInfo.hidden || renderInfo.actionGroups !== undefined) {
		return createEmptyResultComponent();
	}

	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	if (details?.session_id !== undefined) {
		return createEmptyResultComponent();
	}
	const content = result.content.find((item) => item.type === "text");
	const output = details?.output ?? (content?.type === "text" ? content.text : "");
	const footer =
		details?.exit_code !== undefined && details.exit_code !== 0
			? theme.fg("muted", `Exit code: ${details.exit_code}`)
			: undefined;
	return new OutputBlockComponent(output ?? "", theme, footer, {
		expanded: options.expanded,
		truncatedAbove: details?.output_truncated,
		originalTokenCount: details?.original_token_count,
	});
};

export function registerExecCommandTool(
	pi: ExtensionAPI,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
	options: ExecCommandToolOptions = {},
): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
		renderShell: "self",
		promptSnippet: "Run a command.",
		promptGuidelines: [
			"Use exec_command for search, listing files, and local text-file reads.",
			"Prefer `rg`/`rg --files` over `grep`/`find`; for broad searches use `rg -n -M 400 --max-columns-preview` plus globs like `--glob '!*.map'`.",
			"Keep tty disabled unless the command truly needs interactive terminal behavior.",
		],
		parameters: EXEC_COMMAND_PARAMETERS,
		prepareArguments: prepareExecCommandArguments,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("exec_command aborted");
			}
			const typedParams = parseExecCommandParams(params);
			const rewrite = options.rewriteCommand ? await options.rewriteCommand(typedParams.cmd, ctx) : typedParams.cmd;
			const rewrittenCommand = typeof rewrite === "string" ? rewrite : rewrite.command;
			const command = shouldUseRawRipgrep(typedParams.cmd, rewrittenCommand) ? typedParams.cmd : rewrittenCommand;
			const rtkWrapped = typeof rewrite === "string" ? command !== typedParams.cmd : rewrite.rtkWrapped === true;
			if (rtkWrapped) {
				tracker.recordRtkWrapped(toolCallId);
			}
			const streamPartialOutput = !summarizeShellCommand(command).maskAsExplored;
			const result = await sessions.exec(
				{ ...typedParams, cmd: command },
				ctx.cwd,
				signal,
				streamPartialOutput
					? (partial) => {
							onUpdate?.({
								content: [
									{
										type: "text",
										text: formatUnifiedExecResult(partial, typedParams.cmd),
									},
								],
								details: partial,
							});
						}
					: undefined,
			);
			if (result.session_id !== undefined) {
				tracker.recordPersistentSession(toolCallId, result.session_id);
			}
			const resultOptions = options.onResult?.(typedParams, result, ctx);
			return {
				content: [
					{
						type: "text",
						text: formatUnifiedExecResult(result, typedParams.cmd),
					},
				],
				details: result,
				isError: result.exit_code !== undefined && result.exit_code !== 0,
				terminate: resultOptions?.terminate,
			};
		},
		renderCall: ((
			args: { cmd?: unknown },
			theme: {
				fg(role: string, text: string): string;
				bold(text: string): string;
			},
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandCallWithOptionalContext(args, theme, context, tracker, sessions)) as any,
		renderResult: ((
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
			},
			options: { expanded: boolean; isPartial: boolean },
			theme: { fg(role: string, text: string): string },
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandResultWithOptionalContext(result, options, theme, context, tracker, sessions)) as any,
	});
}
