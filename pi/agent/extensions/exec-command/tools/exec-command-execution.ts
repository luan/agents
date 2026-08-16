import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureExecResult } from "../../artifact-store/pi/capture.ts";
import { COMMAND_DETAILS_SCHEMA, projectCommandDetails } from "../../code-mode/tool-results.ts";
import { sessionIdFromContext } from "../../shared/session-context.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING } from "./output-truncation.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.String({ description: "One shell command." }),
	workdir: Type.Optional(
		Type.String({ description: "Optional working directory; defaults to the current turn cwd." }),
	),
	shell: Type.Optional(Type.String({ description: "Optional shell binary; defaults to the user's shell." })),
	tty: Type.Optional(
		Type.Boolean({
			description:
				"Whether to allocate a TTY. Off by default; leave it off unless the command needs interactive terminal behavior. A TTY process keeps stdin open for write_stdin and can be attached from the Hub.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: "How long to wait in milliseconds before yielding. A still-running command keeps its process id.",
		}),
	),
	login: Type.Optional(
		Type.Boolean({ description: "Whether to run the shell with -l/-i semantics. Defaults to true." }),
	),
	max_output_tokens: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_OUTPUT_TOKENS_CEILING,
			description: `Ceiling on returned output tokens. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}, capped at ${MAX_OUTPUT_TOKENS_CEILING}.`,
		}),
	),
});

export interface ExecCommandParams {
	cmd: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
	login?: boolean;
}

export interface BackgroundCaptureContext {
	originalCommand: string;
	executedCommand: string;
	ownerSessionId: string;
}

export interface ExecCommandExecutionOptions {
	onResult?: (
		params: ExecCommandParams,
		result: UnifiedExecResult,
		ctx: ExtensionContext,
		backgroundCapture?: BackgroundCaptureContext,
	) => { terminate?: boolean } | undefined;
	artifactCaptureEnabled?: () => boolean;
	/** Returns the command to run instead, or undefined to run the model's command unchanged. */
	rewriteCommand?: (command: string, signal?: AbortSignal) => Promise<string | undefined>;
}

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
	if (!args || typeof args !== "object") return args as ExecCommandParams;
	const record = args as Record<string, unknown>;
	for (const key of ["timeout_ms", "timeout"]) {
		if (key in record) throw new Error(`exec_command does not support ${key}; use yield_time_ms`);
	}
	const prepared: Record<string, unknown> = { ...record };
	if (!("cmd" in prepared) && "command" in prepared) prepared.cmd = prepared.command;
	if (!("workdir" in prepared)) {
		if ("cwd" in prepared) prepared.workdir = prepared.cwd;
		else if ("working_directory" in prepared) prepared.workdir = prepared.working_directory;
	}
	return prepared as unknown as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") throw new Error("exec_command requires an object parameter");
	const record = params as Record<string, unknown>;
	if (typeof record.cmd !== "string" || record.cmd.trim() === "") {
		throw new Error("exec_command requires a non-empty cmd");
	}
	return {
		cmd: record.cmd,
		workdir: typeof record.workdir === "string" ? record.workdir : undefined,
		shell: typeof record.shell === "string" ? record.shell : undefined,
		tty: typeof record.tty === "boolean" ? record.tty : undefined,
		yield_time_ms: typeof record.yield_time_ms === "number" ? record.yield_time_ms : undefined,
		max_output_tokens: typeof record.max_output_tokens === "number" ? record.max_output_tokens : undefined,
		login: typeof record.login === "boolean" ? record.login : undefined,
	};
}

function shouldCaptureCommandOutput(params: ExecCommandParams, options: ExecCommandExecutionOptions): boolean {
	return !params.tty && (options.artifactCaptureEnabled?.() ?? false);
}

function resolveCaptureContext(
	params: ExecCommandParams,
	executedCommand: string,
	ownerSessionId: string,
): BackgroundCaptureContext {
	return {
		originalCommand: params.cmd,
		executedCommand,
		ownerSessionId,
	};
}

export function createExecCommandExecution(
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
	options: ExecCommandExecutionOptions = {},
) {
	return {
		name: "exec_command",
		label: "exec_command",
		description:
			"Runs one shell command for builds, tests, git, and process control. Use read, search, or find for repository, session, and resource inspection. A command that outlasts its yield keeps running and returns a process id; reach it with write_stdin, never a second exec_command.",
		promptSnippet:
			"Run shell commands only for builds, tests, git, and process control. Use read, search, or find for repository, session, and resource inspection.",
		parameters: EXEC_COMMAND_PARAMETERS,
		nestedResult: {
			details: COMMAND_DETAILS_SCHEMA,
			projectDetails: ({ details }: { details: unknown }) => projectCommandDetails(details),
		},
		prepareArguments: prepareExecCommandArguments,
		async execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (signal?.aborted) throw new Error("exec_command aborted");
			const typedParams = parseExecCommandParams(params);
			tracker.recordStart(toolCallId, typedParams.cmd);
			try {
				const executedCommand = (await options.rewriteCommand?.(typedParams.cmd, signal)) ?? typedParams.cmd;
				const ownerSessionId = sessionIdFromContext(ctx) ?? ctx.cwd;
				const captureEnabled = shouldCaptureCommandOutput(typedParams, options);
				if (captureEnabled) tracker.recordCaptureWrapped(toolCallId);
				const captureContext = captureEnabled
					? resolveCaptureContext(typedParams, executedCommand, ownerSessionId)
					: undefined;
				const result = await sessions.exec(
					{
						cmd: executedCommand,
						workdir: typedParams.workdir,
						shell: typedParams.shell,
						tty: typedParams.tty,
						yield_time_ms: typedParams.yield_time_ms,
						max_output_tokens: typedParams.max_output_tokens,
						login: typedParams.login,
						ownerSessionId,
					},
					ctx.cwd,
					signal,
					(partial) => tracker.recordOutput(toolCallId, partial.output),
				);
				if (result.process_id !== undefined) tracker.recordPersistentSession(toolCallId, result.process_id);
				else if (captureContext && result.terminal_state !== undefined) {
					await captureExecResult(
						{
							...captureContext,
							ownerSessionId: captureContext.ownerSessionId,
							existingUri: result.full_output_ref,
						},
						result,
					);
				}
				options.onResult?.(typedParams, result, ctx, result.process_id !== undefined ? captureContext : undefined);
				return {
					content: [{ type: "text" as const, text: formatUnifiedExecResult(result, executedCommand) }],
					details: result,
					isError:
						(result.exit_code !== undefined && result.exit_code !== 0) ||
						result.cancelled === true ||
						result.session_error !== undefined,
				};
			} finally {
				tracker.recordEnd(toolCallId);
			}
		},
	};
}
