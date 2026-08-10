import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { captureExecResult } from "../../context-guard/pi/capture.ts";
import { getCurrentContextGuardSessionId } from "../../context-guard/pi/current-session.ts";
import { sharedAnimationRenderAllowed } from "../../shared/tui";
import { resolveRuntimeShell } from "../adapter/runtime-shell.ts";
import { type RenderTheme, rawCommandToExecCell, renderExecCellComponent } from "./exec-cell-presentation.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { formattedTruncateText } from "./output-truncation.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const FIXED_COMMAND_CONCURRENCY = 4;
const COMMAND_ITEM = Type.Union([
	Type.String(),
	Type.Object({
		label: Type.Optional(Type.String()),
		command: Type.String(),
	}),
]);

const EXEC_COMMAND_PARAMETERS = Type.Object({
	cmd: Type.Optional(Type.String({ description: "One shell command; normalized to a command list of one." })),
	commands: Type.Optional(
		Type.Array(COMMAND_ITEM, {
			minItems: 1,
			maxItems: 64,
			description: "Shell commands to execute with fixed concurrency four.",
		}),
	),
	name: Type.Optional(Type.String({ description: "Stable process name for a single command." })),
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
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Environment variables added to the command environment.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Maximum command runtime in milliseconds.",
		}),
	),
	tty: Type.Optional(
		Type.Boolean({
			description:
				"Whether to allocate a TTY for a single command. TTY processes can be attached from the Hub. Command lists are non-interactive and wait to completion.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description: "How long to wait in milliseconds before yielding a single command.",
		}),
	),
	login: Type.Optional(
		Type.Boolean({
			description: "Whether to run the shell with -l/-i semantics. Defaults to true.",
		}),
	),
});

interface ExecCommandItem {
	label?: string;
	command: string;
}

interface ExecCommandParams {
	commands: ExecCommandItem[];
	name?: string;
	workdir?: string;
	shell?: string;
	tty?: boolean;
	env?: Record<string, string>;
	timeout_ms?: number;
	yield_time_ms?: number;
	login?: boolean;
}

export interface BackgroundCaptureContext {
	projectDir: string;
	sessionId?: string;
	originalCommand: string;
	executedCommand: string;
	cwd: string;
}

interface ExecCommandToolOptions {
	onResult?: (
		params: ExecCommandParams,
		result: UnifiedExecResult,
		ctx: ExtensionContext,
		backgroundCapture?: BackgroundCaptureContext,
	) => { terminate?: boolean } | undefined;
	contextGuardEnabled?: () => boolean;
	getOriginalCommand?: (toolCallId: string, executedCommand: string) => string | undefined;
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
	return prepared as ExecCommandParams;
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
	if (!params || typeof params !== "object") {
		throw new Error("exec_command requires an object parameter");
	}

	const record = params as Record<string, unknown>;
	if ("mode" in record || "queries" in record || "concurrency" in record) {
		throw new Error("exec_command does not accept mode, queries, or concurrency");
	}
	const hasCmd = typeof record.cmd === "string";
	const hasCommands = Array.isArray(record.commands);
	if (hasCmd === hasCommands) {
		throw new Error("exec_command requires exactly one of 'cmd' or 'commands'");
	}
	const commands = hasCmd
		? [{ command: record.cmd as string }]
		: (record.commands as unknown[]).map((item, index) => {
				if (typeof item === "string") return { command: item };
				if (item && typeof item === "object" && typeof (item as Record<string, unknown>).command === "string") {
					const value = item as Record<string, unknown>;
					return {
						command: value.command as string,
						label: typeof value.label === "string" ? value.label : undefined,
					};
				}
				throw new Error(`exec_command commands[${index}] must be a string or {label?, command}`);
			});
	if (commands.length === 0) throw new Error("exec_command commands must not be empty");
	if (commands.length > 64) throw new Error("exec_command accepts at most 64 commands");
	if (commands.some(({ command }) => command.trim() === "")) {
		throw new Error("exec_command commands must not be empty strings");
	}
	if (commands.length > 1 && record.tty === true) {
		throw new Error("exec_command command lists do not support tty");
	}
	if (commands.length > 1 && typeof record.name === "string") {
		throw new Error("exec_command command lists do not support name");
	}
	if (
		record.env !== undefined &&
		(!record.env ||
			typeof record.env !== "object" ||
			Array.isArray(record.env) ||
			Object.values(record.env).some((value) => typeof value !== "string"))
	) {
		throw new Error("exec_command env must contain only string values");
	}
	if (record.timeout_ms !== undefined && (typeof record.timeout_ms !== "number" || record.timeout_ms <= 0)) {
		throw new Error("exec_command timeout_ms must be a positive number");
	}

	return {
		commands,
		name: typeof record.name === "string" ? record.name : undefined,
		workdir: typeof record.workdir === "string" ? record.workdir : undefined,
		shell: typeof record.shell === "string" ? record.shell : undefined,
		tty: typeof record.tty === "boolean" ? record.tty : undefined,
		env: record.env as Record<string, string> | undefined,
		timeout_ms: typeof record.timeout_ms === "number" ? record.timeout_ms : undefined,
		yield_time_ms: typeof record.yield_time_ms === "number" ? record.yield_time_ms : undefined,
		login: typeof record.login === "boolean" ? record.login : undefined,
	};
}

function isUnifiedExecResult(details: unknown): details is UnifiedExecResult {
	return typeof details === "object" && details !== null;
}

function shouldCaptureCommandOutput(params: ExecCommandParams, options: ExecCommandToolOptions): boolean {
	return !params.tty && (options.contextGuardEnabled?.() ?? false);
}

function resolveCaptureContext(
	toolCallId: string,
	params: ExecCommandParams,
	item: ExecCommandItem,
	ctx: ExtensionContext,
	options: ExecCommandToolOptions,
): BackgroundCaptureContext {
	const cwd = params.workdir ? resolve(ctx.cwd, params.workdir) : ctx.cwd;
	return {
		projectDir: ctx.cwd,
		sessionId: getCurrentContextGuardSessionId(),
		originalCommand: options.getOriginalCommand?.(toolCallId, item.command) ?? item.command,
		executedCommand: item.command,
		cwd,
	};
}

async function mapCommands<T>(
	items: ExecCommandItem[],
	run: (item: ExecCommandItem, index: number) => Promise<T>,
	signal?: AbortSignal,
): Promise<T[]> {
	const results = new Array<T>(items.length);
	let next = 0;
	const worker = async () => {
		while (!signal?.aborted && next < items.length) {
			const index = next++;
			results[index] = await run(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(FIXED_COMMAND_CONCURRENCY, items.length) }, worker));
	return results.filter((result) => result !== undefined);
}

function displayCommand(args: { cmd?: unknown; commands?: unknown }): string {
	if (typeof args.cmd === "string") return args.cmd;
	if (!Array.isArray(args.commands)) return "";
	const commands = args.commands.map((item) =>
		typeof item === "string"
			? item
			: item && typeof item === "object" && typeof (item as Record<string, unknown>).command === "string"
				? String((item as Record<string, unknown>).command)
				: "",
	);
	return commands.length === 1 ? commands[0]! : `${commands.length} commands`;
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
	isError?: boolean;
	isPartial?: boolean;
	lastComponent?: unknown;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
	};
}

const RUNNING_INVALIDATION_MS = 120;
const elapsedTimersByRenderKey = new Map<string, ReturnType<typeof setTimeout>>();

function elapsedInvalidationKey(
	context: ExecCommandRenderContextLike | undefined,
	command: string,
): string | undefined {
	if (context?.toolCallId) return `call:${context.toolCallId}`;
	return command ? `cmd:${command}` : undefined;
}

function clearElapsedInvalidation(context: ExecCommandRenderContextLike | undefined, command = ""): void {
	const state = context?.state;
	if (state?.elapsedTimer) {
		clearTimeout(state.elapsedTimer);
		state.elapsedTimer = undefined;
	}
	const key = elapsedInvalidationKey(context, command);
	if (!key) return;
	const timer = elapsedTimersByRenderKey.get(key);
	if (!timer) return;
	clearTimeout(timer);
	elapsedTimersByRenderKey.delete(key);
}

function scheduleElapsedInvalidation(
	context: ExecCommandRenderContextLike | undefined,
	running: boolean,
	command = "",
): void {
	if (!running) {
		clearElapsedInvalidation(context, command);
		return;
	}
	if (!context?.invalidate) return;
	const key = elapsedInvalidationKey(context, command);
	if (key && elapsedTimersByRenderKey.has(key)) return;
	const state = context.state;
	if (!key && state?.elapsedTimer) return;
	const timer = setTimeout(() => {
		if (key) elapsedTimersByRenderKey.delete(key);
		if (state?.elapsedTimer === timer) state.elapsedTimer = undefined;
		if (sharedAnimationRenderAllowed()) context.invalidate?.();
	}, RUNNING_INVALIDATION_MS);
	if (key) elapsedTimersByRenderKey.set(key, timer);
	if (state) state.elapsedTimer = timer;
}

const renderExecCommandCallWithOptionalContext: any = (
	args: { cmd?: unknown; commands?: unknown },
	theme: RenderTheme,
	context: ExecCommandRenderContextLike | undefined,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
) => {
	const command = displayCommand(args);
	const shell = displayShell(args);
	if (context?.invalidate) tracker.registerRenderContext(context.toolCallId, context.invalidate);
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command);
	const failed = context?.isError === true;
	const snapshot = renderInfo.sessionId !== undefined ? sessions.getSessionSnapshot(renderInfo.sessionId) : undefined;
	const shouldAnimateElapsed = context?.isPartial === true && !snapshot?.running && renderInfo.status === "running";
	scheduleElapsedInvalidation(context, shouldAnimateElapsed, command);
	if (renderInfo.sessionId === undefined && context?.isPartial === false) return createEmptyResultComponent();
	const resolveCell = () => {
		const current = tracker.getRenderInfo(context?.toolCallId, command);
		if (current.sessionId !== undefined) {
			const currentSnapshot = sessions.getSessionSnapshot(current.sessionId);
			const sessionCommand = currentSnapshot?.command ?? sessions.getSessionCommand(current.sessionId) ?? command;
			const running = currentSnapshot?.running ?? current.status === "running";
			const exitCode = currentSnapshot?.exitCode;
			return {
				kind: "terminal-logs" as const,
				status: running ? ("running" as const) : ("done" as const),
				command: sessionCommand,
				shell,
				failed: exitCode !== undefined && exitCode !== 0,
				contextGuardWrapped: current.contextGuardWrapped,
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
			contextGuardWrapped: current.contextGuardWrapped,
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
	tracker: ExecCommandTracker,
	_sessions: ExecSessionManager,
) => {
	const command = context && "args" in context && context.args ? displayCommand((context as any).args) : undefined;
	const shell = displayShell(context?.args);
	const renderInfo = tracker.getRenderInfo(context?.toolCallId, command ?? "");
	const details = isUnifiedExecResult(result.details) ? result.details : undefined;
	if (renderInfo.sessionId !== undefined) return createEmptyResultComponent();
	const failed =
		context?.isError === true ||
		(details?.exit_code !== undefined && details.exit_code !== 0) ||
		details?.timed_out === true ||
		details?.cancelled === true ||
		details?.terminal_state === "session_error";
	const footer =
		details?.exit_code !== undefined && details.exit_code !== 0
			? theme.fg("muted", `Exit code: ${details.exit_code}`)
			: undefined;
	if (details?.process_id !== undefined) {
		return renderExecCellComponent(
			{
				kind: "terminal-logs",
				status: "done",
				command: command ?? "",
				shell,
				failed,
				contextGuardWrapped: renderInfo.contextGuardWrapped,
				terminalSession: {
					operation: "logs",
					processId: details.process_id,
					exitCode: details.exit_code,
				},
				outputBlock: {
					output: details.output,
					footer,
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
			contextGuardWrapped: renderInfo.contextGuardWrapped,
			outputBlock: {
				output: output ?? "",
				footer,
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

export function registerExecCommandTool(
	pi: ExtensionAPI,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
	options: ExecCommandToolOptions = {},
): void {
	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description:
			"Runs one or more shell commands through managed sessions. Every invocation normalizes to a command list; lists use fixed concurrency four. Non-TTY output is captured automatically.",
		renderShell: "self",
		promptSnippet: "Run shell commands for builds, tests, git, process inspection, and other shell-only workflows.",
		promptGuidelines: [
			"Use exec_command for shell-only workflows; prefer active dedicated read, search, and find tools for files.",
			"Use commands for independent shell work; command lists run with fixed concurrency four and preserve input order.",
			"Non-TTY command output is captured automatically; use cg_search with artifactId to retrieve omitted output.",
			"When using shell search, prefer `rg`/`rg --files` over `grep` or shell `find`; for broad searches use line-safe `rg -n -M 400 --max-columns-preview` plus narrow globs.",
			"Keep tty disabled unless one command truly needs interactive terminal behavior.",
		],
		parameters: EXEC_COMMAND_PARAMETERS,
		prepareArguments: prepareExecCommandArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("exec_command aborted");
			const typedParams = parseExecCommandParams(params);
			const multiple = typedParams.commands.length > 1;
			const captureEnabled = shouldCaptureCommandOutput(typedParams, options);
			if (captureEnabled) tracker.recordContextGuardWrapped(toolCallId);
			const startedAt = Date.now();
			const completed = await mapCommands(
				typedParams.commands,
				async (item, index) => {
					const captureContext = captureEnabled
						? resolveCaptureContext(toolCallId, typedParams, item, ctx, options)
						: undefined;
					const streamPartialOutput = !multiple;
					const result = await sessions.exec(
						{
							cmd: item.command,
							name: typedParams.name,
							workdir: typedParams.workdir,
							shell: typedParams.shell,
							tty: typedParams.tty,
							env: typedParams.env,
							timeout_ms: typedParams.timeout_ms,
							yield_time_ms: typedParams.yield_time_ms,
							login: typedParams.login,
							wait_for_exit: multiple,
							ownerSessionId: ctx.sessionManager?.getSessionId?.() ?? ctx.cwd,
						},
						ctx.cwd,
						signal,
						streamPartialOutput
							? (partial) => {
									tracker.recordOutput(toolCallId, partial.output);
								}
							: undefined,
					);
					if (result.process_id !== undefined) {
						tracker.recordPersistentSession(toolCallId, result.process_id);
					} else if (captureContext && result.terminal_state !== undefined) {
						await captureExecResult(captureContext, result);
					}
					if (!multiple) {
						options.onResult?.(
							typedParams,
							result,
							ctx,
							result.process_id !== undefined ? captureContext : undefined,
						);
					}
					return { item, index, result };
				},
				signal,
			);

			if (!multiple) {
				const { item, result } = completed[0]!;
				return {
					content: [{ type: "text", text: formatUnifiedExecResult(result, item.command) }],
					details: result,
					isError:
						(result.exit_code !== undefined && result.exit_code !== 0) ||
						result.timed_out === true ||
						result.cancelled === true ||
						result.session_error !== undefined,
				};
			}

			const sections = completed.map(({ item, result }, index) => {
				const label = item.label?.trim() || `command ${index + 1}`;
				return `## ${label}\n${formatUnifiedExecResult(result, item.command)}`;
			});
			const aggregate = formattedTruncateText(sections.join("\n\n"));
			const failed = completed.some(
				({ result }) =>
					(result.exit_code !== undefined && result.exit_code !== 0) ||
					result.timed_out === true ||
					result.cancelled === true ||
					result.session_error !== undefined,
			);
			const details = {
				chunk_id: "command-list",
				wall_time_seconds: (Date.now() - startedAt) / 1000,
				output: aggregate.output,
				output_truncated: aggregate.output_truncated,
				terminal_state: "exited" as const,
				exit_code: failed ? 1 : 0,
				results: completed.map(({ item, result }) => ({ label: item.label, command: item.command, ...result })),
			};
			return {
				content: [{ type: "text", text: aggregate.output }],
				details,
				isError: failed,
			};
		},
		renderCall: ((
			args: { cmd?: unknown; commands?: unknown },
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
			renderOptions: { expanded: boolean; isPartial: boolean },
			theme: { fg(role: string, text: string): string },
			context?: ExecCommandRenderContextLike,
		) => renderExecCommandResultWithOptionalContext(result, renderOptions, theme, context, tracker, sessions)) as any,
	});
}
