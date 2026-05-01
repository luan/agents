import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { renderExecCommandCall, renderGroupedExecCommandCall, renderOutputBlock } from "./codex-rendering.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
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

interface ExecCommandRenderContextLike {
	toolCallId?: string;
	invalidate?: () => void;
	args?: unknown;
	isError?: boolean;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
	};
}

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
	}, 1000);
}

const renderExecCommandCallWithOptionalContext: any = (
	args: { cmd?: unknown },
	theme: { fg(role: string, text: string): string; bold(text: string): string },
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
) => {
	const command = typeof args.cmd === "string" ? args.cmd : "";
	tracker.registerRenderContext(context?.toolCallId, context?.invalidate ?? (() => {}));
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command);
	const failed = context?.isError === true;
	scheduleElapsedInvalidation(context, renderInfo.status === "running");
	if (renderInfo.hidden) {
		return new Text("", 0, 0);
	}
	const text = renderInfo.actionGroups
		? renderGroupedExecCommandCall(renderInfo.actionGroups, renderInfo.status, theme, failed, renderInfo.elapsedMs)
		: renderExecCommandCall(command, renderInfo.status, theme, failed, renderInfo.elapsedMs);
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
) => {
	if (options.isPartial) {
		return createEmptyResultComponent();
	}

	const command =
		context && "args" in context && context.args && typeof (context as any).args.cmd === "string"
			? (context as any).args.cmd
			: undefined;
	if (tracker.getRenderInfo(context?.toolCallId, command ?? "").hidden) {
		return createEmptyResultComponent();
	}

	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	const content = result.content.find((item) => item.type === "text");
	const output = details?.output ?? (content?.type === "text" ? content.text : "");
	const footer =
		details?.session_id !== undefined
			? theme.fg("accent", `Session ${details.session_id} still running`)
			: details?.exit_code !== undefined && details.exit_code !== 0
				? theme.fg("muted", `Exit code: ${details.exit_code}`)
				: undefined;
	const text = renderOutputBlock(output ?? "", theme, footer, {
		expanded: options.expanded,
		truncatedAbove: details?.output_truncated,
		originalTokenCount: details?.original_token_count,
	});
	return new Text(text, 0, 0);
};

export function registerExecCommandTool(
	pi: ExtensionAPI,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
		renderShell: "self",
		promptSnippet: "Run a command.",
		promptGuidelines: [
			"Use exec_command for search, listing files, and local text-file reads.",
			"Prefer rg or rg --files when possible.",
			"Omit `yield_time_ms` unless you specifically need an early background session; non-interactive commands wait up to two minutes by default.",
			"Keep tty disabled unless the command truly needs interactive terminal behavior.",
		],
		parameters: EXEC_COMMAND_PARAMETERS,
		prepareArguments: prepareExecCommandArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("exec_command aborted");
			}
			const typedParams = parseExecCommandParams(params);
			const result = await sessions.exec(typedParams, ctx.cwd, signal);
			if (result.session_id !== undefined) {
				tracker.recordPersistentSession(toolCallId, result.session_id);
			}
			return {
				content: [
					{
						type: "text",
						text: formatUnifiedExecResult(result, typedParams.cmd),
					},
				],
				details: result,
				isError: result.exit_code !== undefined && result.exit_code !== 0,
			};
		},
		renderCall: ((
			args: { cmd?: unknown },
			theme: {
				fg(role: string, text: string): string;
				bold(text: string): string;
			},
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandCallWithOptionalContext(args, theme, context, tracker)) as any,
		renderResult: ((
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
			},
			options: { expanded: boolean; isPartial: boolean },
			theme: { fg(role: string, text: string): string },
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandResultWithOptionalContext(result, options, theme, context, tracker)) as any,
	});
}
