import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureExecResult } from "../artifact-store/pi/capture.ts";
import { isExecCaptureEnabled } from "../artifact-store/pi/index.ts";
import { runInSession } from "../shared/session-context.ts";
import { defineExtensionTui, markLiveTurnStarted } from "../shared/tui";
import { FLOATING_HUB_OVERLAY_OPTIONS } from "../shared/tui/floating-hub.ts";
import { resolveRuntimeShell } from "./adapter/runtime-shell.ts";
import { lastOutputLine, outputLineCount } from "./tools/exec-cell-rendering-internal.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { type BackgroundCaptureContext, registerExecCommandTool } from "./tools/exec-command-tool.ts";
import {
	createExecSessionManager,
	type ExecSessionManagerOptions,
	type UnifiedExecResult,
} from "./tools/exec-session-manager.ts";
import { formatUnifiedExecResult } from "./tools/unified-exec-format.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import {
	type BackgroundTerminalFinishedDetails,
	BackgroundTerminalPresentation,
	isExecInterruptInput,
	registerBackgroundTerminalMessageRenderers,
} from "./ui/background-terminal-presentation.ts";
import { installExecCommandPiRenderPatches } from "./ui/pi-render-patches.ts";
import { ProcessOverlay, ProcessTerminalStore } from "./ui/process-overlay.ts";

const execCommandTui = defineExtensionTui({ id: "exec-command" });
const RTK_REWRITE_TIMEOUT_MS = 2_000;
const BACKGROUND_TERMINAL_COMPLETION_HOLD_MS = 200;

async function rewriteCommandWithRtk(
	pi: ExtensionAPI,
	command: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await pi.exec("rtk", ["rewrite", command], {
		timeout: RTK_REWRITE_TIMEOUT_MS,
		signal,
	});
	if (result.killed || (result.code !== 0 && result.code !== 3)) return undefined;
	return result.stdout.trim() || undefined;
}

/** Returns the rewritten command, or undefined when the command runs unchanged. */
export function createRtkCommandRewriter(
	pi: ExtensionAPI,
): (command: string, signal?: AbortSignal) => Promise<string | undefined> {
	const rtkAvailable =
		typeof pi.exec === "function"
			? pi
					.exec("rtk", ["--version"], { timeout: RTK_REWRITE_TIMEOUT_MS })
					.then((result) => result.code === 0)
					.catch(() => false)
			: Promise.resolve(false);
	return async (command, signal) => {
		if (process.env.RTK_DISABLED === "1" || !command.trim() || command.startsWith("rtk ")) return undefined;
		if (!(await rtkAvailable)) return undefined;
		try {
			const rewritten = await rewriteCommandWithRtk(pi, command, signal);
			return rewritten && rewritten !== command ? rewritten : undefined;
		} catch (error) {
			console.warn("[rtk] rewrite failed; passing through command", error);
			return undefined;
		}
	};
}

function parseStopSessionId(args: string): number | undefined | "invalid" {
	const value = args.trim().replace(/^#/, "");
	if (!value) return undefined;
	if (!/^\d+$/.test(value)) return "invalid";
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : "invalid";
}

const EXEC_COMMAND_COMPLETED_MESSAGE = "exec_command.completed";
const EXEC_COMMAND_SESSION_ERROR_MESSAGE = "exec_command.session_error";

const COMPLETION_OUTPUT_MAX_LINES = 20;

function compactBackgroundTerminalCompletionOutput(output: string): string {
	const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
	const trailingNewline = plain.endsWith("\n");
	const body = trailingNewline ? plain.slice(0, -1) : plain;
	if (!body) return "";
	const lines = body.split("\n");
	if (lines.length <= COMPLETION_OUTPUT_MAX_LINES) return plain;
	const headCount = Math.floor((COMPLETION_OUTPUT_MAX_LINES - 1) / 2);
	const tailCount = COMPLETION_OUTPUT_MAX_LINES - headCount - 1;
	const omitted = lines.length - headCount - tailCount;
	const compact = [
		...lines.slice(0, headCount),
		`… ${omitted} lines omitted; use /ps for full output …`,
		...lines.slice(-tailCount),
	].join("\n");
	return trailingNewline ? `${compact}\n` : compact;
}

function backgroundTerminalDetailsToUnifiedResult(details: BackgroundTerminalFinishedDetails): UnifiedExecResult {
	return {
		chunk_id: "",
		wall_time_seconds: details.elapsed_ms / 1000,
		output: details.output,
		exit_code: details.exit_code,
		terminal_state: details.terminal_state,
		cancelled: details.cancelled,
		session_error: details.session_error,
		original_token_count: details.original_token_count,
		output_truncated: details.output_truncated,
		artifact_capture: details.artifact_capture,
		artifact_capture_failure: details.artifact_capture_failure,
		artifact_capture_truncated: details.artifact_capture_truncated,
		process_id: details.process_id,
	};
}

export interface ExecCommandExtensionOptions {
	sessionManagerOptions?: ExecSessionManagerOptions;
	backgroundTerminalCompletionHoldMs?: number;
}
export default function execCommandExtension(pi: ExtensionAPI, options: ExecCommandExtensionOptions = {}) {
	const rewriteCommand = createRtkCommandRewriter(pi);
	// Tells replayed history apart from live calls, so a resumed transcript does not animate.
	pi.on?.("turn_start", () => markLiveTurnStarted());
	installExecCommandPiRenderPatches();
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager(options.sessionManagerOptions);
	const processStore = new ProcessTerminalStore(sessions);
	const completionMessageSessions = new Set<number>();
	const pendingCompletionMessages = new Map<number, ReturnType<typeof setTimeout>>();
	const backgroundCaptureContexts = new Map<number, BackgroundCaptureContext>();
	const backgroundCaptureFailures = new Map<number, string>();
	const backgroundTerminalShells = new Map<number, string | undefined>();

	let agentTurnActive = false;
	let uninstallForegroundExecInterrupt: (() => void) | undefined;
	const backgroundTerminalCompletionHoldMs =
		options.backgroundTerminalCompletionHoldMs ?? BACKGROUND_TERMINAL_COMPLETION_HOLD_MS;
	registerBackgroundTerminalMessageRenderers(pi, EXEC_COMMAND_COMPLETED_MESSAGE, EXEC_COMMAND_SESSION_ERROR_MESSAGE);
	function cancelBackgroundTerminalCompletionMessage(sessionId: number): void {
		const timer = pendingCompletionMessages.get(sessionId);
		if (!timer) return;
		clearTimeout(timer);
		pendingCompletionMessages.delete(sessionId);
	}

	function clearPendingBackgroundTerminalCompletionMessages(): void {
		for (const timer of pendingCompletionMessages.values()) {
			clearTimeout(timer);
		}
		pendingCompletionMessages.clear();
	}

	function isTerminalExecResult(result: UnifiedExecResult): boolean {
		return (
			result.terminal_state !== undefined ||
			result.exit_code !== undefined ||
			result.cancelled === true ||
			typeof result.session_error === "string"
		);
	}

	function scheduleBackgroundTerminalCompletionMessage(
		sessionId: number,
		message: unknown,
		options: { deliverAs: "followUp"; triggerTurn: true },
	): void {
		cancelBackgroundTerminalCompletionMessage(sessionId);
		const timer = setTimeout(() => {
			pendingCompletionMessages.delete(sessionId);
			(pi as any).sendMessage?.(message, options);
		}, backgroundTerminalCompletionHoldMs);
		timer.unref?.();
		pendingCompletionMessages.set(sessionId, timer);
	}

	const backgroundTerminalPresentation = new BackgroundTerminalPresentation(
		() => sessions.listSessions(),
		(output) => ({ lineCount: outputLineCount(output), lastLine: lastOutputLine(output) }),
	);
	function installForegroundExecInterrupt(ctx: ExtensionContext): void {
		uninstallForegroundExecInterrupt?.();
		const onTerminalInput = ctx.ui?.onTerminalInput;
		if (!onTerminalInput) {
			uninstallForegroundExecInterrupt = undefined;
			return;
		}
		// The tracker, not a set built from `tool_execution_start`: that event never fires for a cell's
		// `tools.exec_command(...)`, so escape could not interrupt a call a cell started.
		uninstallForegroundExecInterrupt = onTerminalInput((data) => {
			if (!tracker.hasCallInFlight() || !isExecInterruptInput(data)) return undefined;
			ctx.abort();
			// `ctx.abort()` reaches only a session whose caller plumbed the signal; a cell orphaned by
			// code-mode/kernel.ts:134 passes `signal: undefined`. Kill by ownership as well.
			const stopped = sessions.interruptForeground();
			ctx.ui.notify(
				stopped > 0
					? `Interrupting foreground exec_command (${stopped} killed)...`
					: "Interrupting foreground exec_command...",
				"info",
			);
			return { consume: true };
		});
	}

	function clearForegroundExecInterrupt(): void {
		uninstallForegroundExecInterrupt?.();
		uninstallForegroundExecInterrupt = undefined;
	}

	registerExecCommandTool(pi, tracker, sessions, {
		onResult: (input, result, _ctx, captureContext) => {
			if (result.process_id === undefined) return;
			completionMessageSessions.add(result.process_id);
			backgroundTerminalShells.set(result.process_id, resolveRuntimeShell(input.shell ?? process.env.SHELL));
			if (captureContext) backgroundCaptureContexts.set(result.process_id, captureContext);
		},
		artifactCaptureEnabled: isExecCaptureEnabled,
		rewriteCommand,
		presentation: {
			state: {
				getRenderInfo: (toolCallId, command) => tracker.getRenderInfo(toolCallId, command),
				getSessionSnapshot: (sessionId) => {
					const snapshot = sessions.getSessionSnapshot(sessionId);
					if (snapshot) return snapshot;
					const command = sessions.getSessionCommand(sessionId);
					return command === undefined ? undefined : { command, running: false, output: "", elapsedMs: 0 };
				},
			},
			intents: {
				registerRenderContext: (toolCallId, invalidate) => tracker.registerRenderContext(toolCallId, invalidate),
			},
		},
	});
	registerWriteStdinTool(pi, sessions, {
		onResult: (_input, result) => {
			if (isTerminalExecResult(result)) {
				const processId = result.process_id;
				if (processId === undefined) return;
				cancelBackgroundTerminalCompletionMessage(processId);
				const captureFailure = backgroundCaptureFailures.get(processId);
				if (captureFailure) {
					result.artifact_capture_failure = captureFailure;
					backgroundCaptureFailures.delete(processId);
				}
			}
		},
		presentation: {
			getSessionSnapshot: (sessionId) => {
				const snapshot = sessions.getSessionSnapshot(sessionId);
				if (snapshot) return snapshot;
				const record = sessions.describe(sessionId);
				const command = sessions.getSessionCommand(sessionId) ?? record?.command;
				const tty = sessions.getSessionTty(sessionId);
				if (command === undefined && tty === undefined && record === undefined) return undefined;
				return {
					command,
					running: record?.running ?? false,
					stdinOpen: record?.running ? record.stdinOpen : undefined,
					tty: tty === true,
				};
			},
		},
	});
	sessions.onSessionExit((sessionId, command) => {
		void (async () => {
			const snapshot = sessions.getSessionSnapshot(sessionId);
			const captureContext = backgroundCaptureContexts.get(sessionId);
			backgroundCaptureContexts.delete(sessionId);
			tracker.recordSessionFinished(sessionId);
			const shouldEmitCompletionMessage = completionMessageSessions.has(sessionId);
			completionMessageSessions.delete(sessionId);
			const shell = backgroundTerminalShells.get(sessionId);
			backgroundTerminalShells.delete(sessionId);
			if (!snapshot) return;
			const details: BackgroundTerminalFinishedDetails = {
				process_id: sessionId,
				command,
				shell,
				output: snapshot.output,
				exit_code: snapshot.exitCode,
				terminal_state: snapshot.terminalState,
				cancelled: snapshot.cancelled,
				session_error: snapshot.sessionError,
				elapsed_ms: snapshot.elapsedMs,
				output_truncated: snapshot.outputTruncated,
			};
			if (snapshot.originalTokenCount !== undefined) {
				details.original_token_count = snapshot.originalTokenCount;
			}
			if (captureContext) {
				Object.defineProperty(details, "capture_output", {
					value: snapshot.captureOutput,
					enumerable: false,
				});
				Object.defineProperty(details, "capture_output_truncated", {
					value: snapshot.captureOutputTruncated,
					enumerable: false,
				});
				// Reuses the artifact `refreshFullOutputRef` already filled from this process's drains, so the URI a
				// drain handed the model keeps resolving after the session is deleted.
				await runInSession(captureContext.ownerSessionId, () =>
					captureExecResult(
						{
							...captureContext,
							ownerSessionId: captureContext.ownerSessionId,
							existingUri: snapshot.artifactUri,
						},
						details,
					),
				);
				// Lets `unreachableProcessMessage` name where the output went once the session is deleted.
				if (details.artifact_capture)
					sessions.recordSessionArtifact(sessionId, details.artifact_capture.artifact_id);
			}
			if (agentTurnActive && details.artifact_capture_failure) {
				backgroundCaptureFailures.set(sessionId, details.artifact_capture_failure);
			}

			if (!shouldEmitCompletionMessage || agentTurnActive) return;
			const completionResult = backgroundTerminalDetailsToUnifiedResult(details);
			completionResult.output = compactBackgroundTerminalCompletionOutput(completionResult.output);
			scheduleBackgroundTerminalCompletionMessage(
				sessionId,
				{
					customType:
						snapshot.terminalState === "session_error"
							? EXEC_COMMAND_SESSION_ERROR_MESSAGE
							: EXEC_COMMAND_COMPLETED_MESSAGE,
					content: formatUnifiedExecResult(completionResult, command),
					display: true,
					details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		})();
	});
	sessions.onSessionUpdate(() => {
		tracker.invalidateSessions();
		backgroundTerminalPresentation.update();
	});
	const openProcessHub = async (ctx: ExtensionContext) => {
		await execCommandTui
			.bind(ctx)
			.overlays.openComponent<undefined>(
				(tui, theme, _keybindings, done) =>
					new ProcessOverlay(processStore, sessions, tui, theme, ctx.sessionManager.getSessionId(), () =>
						done(undefined),
					),
				{
					overlay: true,
					overlayOptions: FLOATING_HUB_OVERLAY_OPTIONS,
				},
			);
	};

	pi.registerCommand("ps", {
		description: "show processes for this session",
		handler: async (_args, ctx) => openProcessHub(ctx),
	});
	pi.registerShortcut?.("alt+s", {
		description: "Toggle processes for this session",
		handler: openProcessHub,
	});

	pi.registerCommand("stop", {
		description: "stop all background terminals",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim().replace(/^#/, "");
			const items = sessions
				.listSessions()
				.filter((session) => String(session.id).startsWith(value))
				.map((session) => ({
					value: String(session.id),
					label: `#${session.id}`,
					description: session.command,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			backgroundTerminalPresentation.setContext(ctx);
			const sessionId = parseStopSessionId(args);
			if (sessionId === "invalid") {
				ctx.ui.notify("Usage: /stop [id]", "warning");
				return;
			}
			if (sessionId === undefined) {
				const stopped = sessions.stopAllSessions();
				const terminalNoun = `background terminal${stopped === 1 ? "" : "s"}`;
				ctx.ui.notify(
					stopped === 0 ? "No background terminals to stop." : `Stopped ${stopped} ${terminalNoun}.`,
					"info",
				);
				return;
			}
			if (!sessions.stopSession(sessionId)) {
				ctx.ui.notify(`No background terminal with id ${sessionId}.`, "warning");
				return;
			}
			ctx.ui.notify(`Stopped background terminal #${sessionId}.`, "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		agentTurnActive = false;
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "resume" || reason === "new" || reason === "fork") {
			backgroundTerminalPresentation.clear();
			sessions.shutdown();
		}
		installForegroundExecInterrupt(ctx);
		backgroundTerminalPresentation.setContext(ctx);
		tracker.clear();
		completionMessageSessions.clear();
		backgroundCaptureContexts.clear();
		backgroundCaptureFailures.clear();
		clearPendingBackgroundTerminalCompletionMessages();
	});
	pi.on("session_tree", () => {
		agentTurnActive = false;
		tracker.clear();
		completionMessageSessions.clear();
		backgroundCaptureContexts.clear();
		backgroundCaptureFailures.clear();
		clearPendingBackgroundTerminalCompletionMessages();
	});
	pi.on("agent_start", () => {
		agentTurnActive = true;
	});
	pi.on("agent_end", () => {
		agentTurnActive = false;
	});
	pi.on("tool_execution_start", (_event, ctx) => {
		backgroundTerminalPresentation.setContext(ctx);
	});
	// Bounding lives in the central tool-policy handler; what stays here is the
	// exec-specific reading of a terminal outcome. A shell command that exits
	// nonzero, is cancelled, or loses its session is a failed call, and nothing
	// outside this extension knows how to read those fields.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "exec_command" && event.toolName !== "write_stdin") return undefined;
		const details = event.details;
		if (!details || typeof details !== "object") return undefined;
		const resultDetails = details as {
			exit_code?: unknown;
			cancelled?: unknown;
			session_error?: unknown;
		};
		const failed =
			(typeof resultDetails.exit_code === "number" && resultDetails.exit_code !== 0) ||
			resultDetails.cancelled === true ||
			typeof resultDetails.session_error === "string";
		return failed ? { isError: true } : undefined;
	});
	pi.on("session_shutdown", () => {
		agentTurnActive = false;
		completionMessageSessions.clear();
		backgroundCaptureFailures.clear();
		clearPendingBackgroundTerminalCompletionMessages();
		clearForegroundExecInterrupt();
		backgroundTerminalPresentation.clear();
		tracker.clear();
		processStore.dispose();
		sessions.shutdown();
	});
}
