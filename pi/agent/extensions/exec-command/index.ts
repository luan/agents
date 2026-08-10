import {
	BashExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { captureExecResult } from "../context-guard/pi/capture.ts";
import { isExecCommandContextGuardEnabled } from "../context-guard/pi/index.ts";
import { attachRuntimeTerminal, registerRuntimeHubSource } from "../shared/runtime-hub";
import {
	type AnimationMount,
	defineExtensionTui,
	markLiveTurnStarted,
	registerExtensionMessageRenderer,
	setOrderedAboveEditorWidget,
	sharedAnimationRenderScheduler,
} from "../shared/tui";
import { createRmuxPtyBackend, resolveRmuxBinary } from "./adapter/rmux-pty-backend.ts";
import { resolveRuntimeShell } from "./adapter/runtime-shell.ts";
import {
	type RenderTheme,
	rawCommandToExecCell,
	renderBackgroundTerminalHud,
	renderExecCell,
	renderExecCellComponent,
} from "./tools/exec-cell-presentation.ts";
import { lastOutputLine, outputLineCount } from "./tools/exec-cell-rendering-internal.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { type BackgroundCaptureContext, registerExecCommandTool } from "./tools/exec-command-tool.ts";
import {
	createExecSessionManager,
	type ExecSessionRecord,
	type UnifiedExecResult,
} from "./tools/exec-session-manager.ts";
import { formattedTruncateText } from "./tools/output-truncation.ts";
import { registerProcessControlTools } from "./tools/process-control-tools.ts";
import { registerProcessLogsTool } from "./tools/process-logs-tool.ts";
import { formatUnifiedExecResult } from "./tools/unified-exec-format.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import { BackgroundTerminalOverlay } from "./ui/background-terminal-overlay.ts";

const execCommandTui = defineExtensionTui({ id: "exec-command" });
const RTK_REWRITE_TIMEOUT_MS = 2_000;

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

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

const EMPTY_SELF_SHELL_ROW_PATCH = Symbol.for("agents.exec-command.empty-self-shell-row-patch");
const USER_BASH_RENDER_PATCH = Symbol.for("agents.exec-command.user-bash-render-patch");
const ANSI_PATTERN =
	/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*(?:\u001b\\)|_[^\u001b]*(?:\u001b\\)|\^[^\u001b]*(?:\u001b\\))/g;
const ANSI_RESET = "\x1b[0m";
const USER_BASH_RENDER_THEME: RenderTheme = {
	fg: (role, text) => `${ansiForRole(role)}${text}${ANSI_RESET}`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

interface ToolExecutionPrototype {
	render(width: number): string[];
	getRenderShell?(): "default" | "self";
	hasRendererDefinition?(): boolean;
	[EMPTY_SELF_SHELL_ROW_PATCH]?: true;
}

interface BashExecutionPrototype {
	command: string;
	outputLines: string[];
	status: "running" | "complete" | "cancelled" | "error";
	exitCode?: number;
	loader?: unknown;
	truncationResult?: { truncated?: boolean; content?: string };
	fullOutputPath?: string;
	expanded: boolean;
	contentContainer: { clear(): void; addChild(child: unknown): void };
	[USER_BASH_RENDER_PATCH]?: true;
	updateDisplay(): void;
	render(width: number): string[];
}

function ansiForRole(role: string): string {
	switch (role) {
		case "success":
			return "\x1b[32m";
		case "error":
			return "\x1b[31m";
		case "dim":
			return "\x1b[2m";
		case "muted":
			return "\x1b[38;5;244m";
		case "syntaxFunction":
			return "\x1b[38;2;220;220;170m";
		case "syntaxKeyword":
			return "\x1b[38;2;86;156;214m";
		case "syntaxString":
			return "\x1b[38;2;206;145;120m";
		case "syntaxNumber":
			return "\x1b[38;2;181;206;168m";
		case "syntaxOperator":
		case "syntaxPunctuation":
			return "\x1b[38;2;212;212;212m";
		default:
			return "";
	}
}

function hasVisibleLineContent(lines: string[]): boolean {
	return lines.some((line) => line.replace(ANSI_PATTERN, "").trim().length > 0);
}

function installEmptySelfShellRowPatch(): void {
	const proto = ToolExecutionComponent.prototype as ToolExecutionPrototype;
	if (proto[EMPTY_SELF_SHELL_ROW_PATCH]) return;
	const originalRender = proto.render;
	proto.render = function renderWithoutEmptySelfShellRows(this: ToolExecutionPrototype, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (this.getRenderShell?.() === "self" && this.hasRendererDefinition?.() && !hasVisibleLineContent(lines)) {
			return [];
		}
		return lines;
	};
	proto[EMPTY_SELF_SHELL_ROW_PATCH] = true;
}

function installUserBashRenderPatch(): void {
	const proto = BashExecutionComponent.prototype as BashExecutionPrototype;
	if (proto[USER_BASH_RENDER_PATCH]) return;
	proto.render = function renderUserBashWithoutFrame(this: BashExecutionPrototype, width: number): string[] {
		return this.contentContainer.render(width);
	};
	proto.updateDisplay = function updateUserBashDisplay(this: BashExecutionPrototype): void {
		const output = this.outputLines.join("\n");
		const running = this.status === "running";
		const failed = this.status === "error" || this.status === "cancelled";
		this.contentContainer.clear();
		this.contentContainer.addChild(
			new Text(
				renderExecCell(
					{
						kind: "user-command",
						status: running ? "running" : "done",
						command: this.command,
						failed,
					},
					{ theme: USER_BASH_RENDER_THEME, part: "header" },
				),
				1,
				0,
			),
		);

		if (output.length > 0 || !running) {
			const footerParts: string[] = [];
			if (this.status === "cancelled") footerParts.push("(cancelled)");
			if (this.status === "error") footerParts.push(`(exit ${this.exitCode})`);
			if ((this.truncationResult?.truncated || this.fullOutputPath) && this.fullOutputPath) {
				footerParts.push(`Output truncated. Full output: ${this.fullOutputPath}`);
			}
			this.contentContainer.addChild(
				new Text(
					`\n${renderExecCell(
						{
							kind: "user-command",
							status: running ? "running" : "done",
							outputBlock: {
								output,
								footer: footerParts.join("\n") || undefined,
								options: {
									expanded: this.expanded,
									maxLines: 20,
									truncatedAbove: this.truncationResult?.truncated,
								},
							},
						},
						{ theme: USER_BASH_RENDER_THEME, part: "output" },
					)}`,
					1,
					0,
				),
			);
		}

		if (running && this.loader) this.contentContainer.addChild(this.loader);
	};
	proto[USER_BASH_RENDER_PATCH] = true;
}

function getCommandArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("cmd" in args)) return undefined;
	return typeof args.cmd === "string" ? args.cmd : undefined;
}

function truncateTextToolResultContent(content: unknown): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	let changed = false;
	const next = content.map((item) => {
		if (!item || typeof item !== "object" || !("type" in item) || item.type !== "text") return item;
		if (!("text" in item) || typeof item.text !== "string") return item;
		const truncated = formattedTruncateText(item.text);
		if (!truncated.output_truncated) return item;
		changed = true;
		return { ...item, text: truncated.output };
	});
	return changed ? next : undefined;
}

function parseStopSessionId(args: string): number | undefined | "invalid" {
	const value = args.trim().replace(/^#/, "");
	if (!value) return undefined;
	if (!/^\d+$/.test(value)) return "invalid";
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : "invalid";
}

const BACKGROUND_TERMINAL_STATUS_KEY = "background-terminals";
const EXEC_COMMAND_COMPLETED_MESSAGE = "exec_command.completed";
const EXEC_COMMAND_SESSION_ERROR_MESSAGE = "exec_command.session_error";
const BACKGROUND_TERMINAL_HUD_FRAME_MS = 32;
interface BackgroundTerminalStatusUi {
	setStatus(key: string, text: string | undefined): void;
	setWidget?(
		key: string,
		content:
			| undefined
			| ((
					tui: { requestRender(): void },
					theme: RenderTheme,
			  ) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

interface BackgroundTerminalFinishedDetails {
	process_id: number;
	command: string;
	shell?: string;
	output: string;
	exit_code?: number;
	terminal_state?: "exited" | "timed_out" | "cancelled" | "session_error";
	timed_out?: boolean;
	cancelled?: boolean;
	session_error?: string;
	elapsed_ms: number;
	output_truncated: boolean;
	original_token_count?: number;
	context_guard_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
	};
	context_guard_capture_failure?: string;
	context_guard_capture_truncated?: boolean;
	capture_output?: string;
	capture_output_truncated?: boolean;
}

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
		timed_out: details.timed_out,
		cancelled: details.cancelled,
		session_error: details.session_error,
		original_token_count: details.original_token_count,
		output_truncated: details.output_truncated,
		context_guard_capture: details.context_guard_capture,
		context_guard_capture_failure: details.context_guard_capture_failure,
		context_guard_capture_truncated: details.context_guard_capture_truncated,
		process_id: details.process_id,
	};
}

export default function execCommandExtension(pi: ExtensionAPI) {
	const rtkAvailable =
		typeof pi.exec === "function"
			? pi
					.exec("rtk", ["--version"], { timeout: RTK_REWRITE_TIMEOUT_MS })
					.then((result) => result.code === 0)
					.catch(() => false)
			: Promise.resolve(false);
	// Tells replayed history apart from live calls, so a resumed transcript does not animate.
	pi.on?.("turn_start", () => markLiveTurnStarted());
	installEmptySelfShellRowPatch();
	installUserBashRenderPatch();
	const tracker = createExecCommandTracker();
	const rmuxBinary = resolveRmuxBinary();
	const sessions = createExecSessionManager({
		ptyBackend: rmuxBinary ? createRmuxPtyBackend({ binary: rmuxBinary }) : undefined,
	});
	let currentExecCtx: ExtensionContext | undefined;
	let unregisterHubSource: (() => void) | undefined;
	const openProcess = async (processId: number) => {
		if (!currentExecCtx) return;
		await execCommandTui
			.bind(currentExecCtx)
			.overlays.openComponent<undefined>(
				(tui, theme, _keybindings, done) =>
					new BackgroundTerminalOverlay(sessions, tui, theme, done, undefined, processId),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 60, maxHeight: "90%" },
				},
			);
	};
	const hubSource = {
		list: (ctx: ExtensionContext) =>
			sessions
				.listSessions()
				.filter((record) => record.ownerSessionId === ctx.sessionManager.getSessionId())
				.map((record) => ({
					key: `process:${record.id}`,
					kind: record.stdinOpen ? ("terminal" as const) : ("job" as const),
					label: record.name,
					status: record.running ? "running" : record.exitCode === 0 ? "completed" : "error",
					description: record.command,
					lastActivity: record.finishedAtMs ?? record.startedAtMs,
					open: () => openProcess(record.id),
					attach: record.attachment ? (tui) => attachRuntimeTerminal(record.attachment!, tui) : undefined,
					stop: () => sessions.stopSession(record.id),
					restart: async () => Boolean(await sessions.restart(record.id)),
				})),
	};
	let shuttingDown = false;
	let statusUi: BackgroundTerminalStatusUi | undefined;
	let lastBackgroundTerminalStatus: string | undefined;
	let backgroundTerminalWidgetRegistered = false;
	let backgroundTerminalWidgetTui: { requestRender(): void } | undefined;
	let backgroundTerminalWidgetTimer: AnimationMount | undefined;
	const completionMessageSessions = new Set<number>();
	const pendingCompletionMessages = new Map<number, ReturnType<typeof setTimeout>>();
	const backgroundTerminalOutputSummaries = new Map<
		number,
		{ output: string; lineCount: number; lastLine?: string }
	>();
	const backgroundCaptureContexts = new Map<number, BackgroundCaptureContext>();
	const backgroundCaptureFailures = new Map<number, string>();
	const backgroundTerminalShells = new Map<number, string | undefined>();

	const originalCommands = new Map<string, Map<string, string>>();
	let agentTurnActive = false;
	const foregroundExecToolCalls = new Set<string>();
	let uninstallForegroundExecInterrupt: (() => void) | undefined;
	const BACKGROUND_TERMINAL_COMPLETION_HOLD_MS = 200;
	const renderBackgroundTerminalFinishedMessage = (
		message: { details?: BackgroundTerminalFinishedDetails },
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
	) => {
		const details = message.details;
		if (!details) return undefined;
		const failed =
			(details.exit_code !== undefined && details.exit_code !== 0) ||
			details.timed_out === true ||
			details.cancelled === true ||
			details.terminal_state === "session_error";
		const footer = (() => {
			if (details.terminal_state === "session_error") return theme.fg("muted", "Session error");
			if (details.timed_out) return theme.fg("muted", "Timed out");
			if (details.cancelled) return theme.fg("muted", "Cancelled");
			if (details.exit_code !== undefined && details.exit_code !== 0) {
				return theme.fg("muted", `Exit code: ${details.exit_code}`);
			}
			return undefined;
		})();
		return renderExecCellComponent(
			rawCommandToExecCell({
				command: details.command,
				shell: details.shell ?? process.env.SHELL,
				status: "done",
				elapsedMs: details.elapsed_ms,
				failed,
				outputBlock: {
					output: details.output,
					footer,
					options: { expanded, maxLines: 8 },
				},
			}),
			{ theme },
		);
	};
	registerExtensionMessageRenderer(pi as any, EXEC_COMMAND_COMPLETED_MESSAGE, renderBackgroundTerminalFinishedMessage);
	registerExtensionMessageRenderer(
		pi as any,
		EXEC_COMMAND_SESSION_ERROR_MESSAGE,
		renderBackgroundTerminalFinishedMessage,
	);
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
			result.timed_out === true ||
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
		}, BACKGROUND_TERMINAL_COMPLETION_HOLD_MS);
		timer.unref?.();
		pendingCompletionMessages.set(sessionId, timer);
	}

	const syncToolPolicy = () => {
		if (shuttingDown) return;
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => toolName !== "bash");
		if (!next.includes("exec_command")) next.push("exec_command");
		if (!next.includes("write_stdin")) next.push("write_stdin");
		if (!next.includes("process_logs")) next.push("process_logs");
		if (!next.includes("process_list")) next.push("process_list");
		if (!next.includes("process_describe")) next.push("process_describe");
		if (!next.includes("process_wait")) next.push("process_wait");
		if (!next.includes("process_resize")) next.push("process_resize");
		if (!next.includes("process_signal")) next.push("process_signal");
		if (!next.includes("process_restart")) next.push("process_restart");
		if (!next.includes("process_stop")) next.push("process_stop");
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	const updateBackgroundTerminalStatus = () => {
		if (!statusUi) return;
		const records = sessions.listSessions();
		const runningRecords = records.filter((record) => record.running);
		const nextStatus =
			records.length === 0
				? undefined
				: (() => {
						const runningCount = records.filter((record) => record.running).length;
						const ttyCount = records.filter((record) => record.stdinOpen).length;
						const terminalNoun = `background terminal${records.length === 1 ? "" : "s"}`;
						return `${records.length} ${terminalNoun} · ${runningCount} running${
							ttyCount > 0 ? ` · ${ttyCount} tty` : ""
						}`;
					})();
		if (nextStatus !== lastBackgroundTerminalStatus) {
			statusUi.setStatus(BACKGROUND_TERMINAL_STATUS_KEY, nextStatus);
			lastBackgroundTerminalStatus = nextStatus;
		}

		if (runningRecords.length === 0) {
			clearBackgroundTerminalWidget();
		} else {
			registerOrRefreshBackgroundTerminalWidget();
		}
	};

	const getBackgroundTerminalOutputSummary = (record: ExecSessionRecord) => {
		const cached = backgroundTerminalOutputSummaries.get(record.id);
		if (cached?.output === record.output) return cached;
		const summary = {
			output: record.output,
			lineCount: outputLineCount(record.output),
			lastLine: lastOutputLine(record.output),
		};
		backgroundTerminalOutputSummaries.set(record.id, summary);
		return summary;
	};

	const renderBackgroundTerminalWidget = (theme: RenderTheme, width: number): string[] => {
		const runningRecords = sessions.listSessions().filter((record) => record.running);
		const runningIds = new Set(runningRecords.map((record) => record.id));
		for (const id of backgroundTerminalOutputSummaries.keys()) {
			if (!runningIds.has(id)) backgroundTerminalOutputSummaries.delete(id);
		}
		if (runningRecords.length === 0) return [];
		const lines = runningRecords
			.slice(0, 4)
			.map((record) => renderBackgroundTerminalWidgetLine(record, theme, width));
		const omitted = runningRecords.length - lines.length;
		if (omitted > 0) {
			lines.push(theme.fg("dim", `… ${omitted} more background terminal${omitted === 1 ? "" : "s"}`));
		}
		return lines;
	};

	const renderBackgroundTerminalWidgetLine = (
		record: ExecSessionRecord,
		theme: RenderTheme,
		width: number,
	): string => {
		const outputSummary = getBackgroundTerminalOutputSummary(record);
		return renderBackgroundTerminalHud(
			{
				id: record.id,
				command: record.command,
				output: record.output,
				lineCount: outputSummary.lineCount,
				lastLine: outputSummary.lastLine,
				startedAtMs: record.startedAtMs,
				stdinOpen: record.stdinOpen,
			},
			{ theme, width },
		);
	};

	function registerOrRefreshBackgroundTerminalWidget() {
		if (!statusUi?.setWidget) return;
		if (!backgroundTerminalWidgetRegistered) {
			setOrderedAboveEditorWidget(
				statusUi as { setWidget: NonNullable<BackgroundTerminalStatusUi["setWidget"]> },
				BACKGROUND_TERMINAL_STATUS_KEY,
				(tui, theme) => {
					backgroundTerminalWidgetTui = tui;
					return {
						render: (width) => renderBackgroundTerminalWidget(theme, width),
						invalidate: () => {
							backgroundTerminalWidgetTimer?.dispose();
							backgroundTerminalWidgetTimer = undefined;
							backgroundTerminalWidgetRegistered = false;
							backgroundTerminalWidgetTui = undefined;
						},
					};
				},
			);
			backgroundTerminalWidgetRegistered = true;
		}
		if (!backgroundTerminalWidgetTimer && backgroundTerminalWidgetTui) {
			backgroundTerminalWidgetTimer = sharedAnimationRenderScheduler.mount(
				backgroundTerminalWidgetTui,
				BACKGROUND_TERMINAL_HUD_FRAME_MS,
			);
		}
	}

	function clearBackgroundTerminalWidget() {
		if (backgroundTerminalWidgetTimer) {
			backgroundTerminalWidgetTimer.dispose();
			backgroundTerminalWidgetTimer = undefined;
		}
		if (backgroundTerminalWidgetRegistered) {
			setOrderedAboveEditorWidget(
				statusUi as { setWidget: NonNullable<BackgroundTerminalStatusUi["setWidget"]> },
				BACKGROUND_TERMINAL_STATUS_KEY,
				undefined,
			);
		}
		backgroundTerminalWidgetRegistered = false;
		backgroundTerminalWidgetTui = undefined;
		backgroundTerminalOutputSummaries.clear();
	}

	const setBackgroundTerminalStatusUi = (ctx: ExtensionContext | undefined) => {
		if (ctx?.hasUI === false) return;
		const ui = ctx?.ui as BackgroundTerminalStatusUi | undefined;
		if (!ui?.setStatus) return;
		statusUi = ui;
		updateBackgroundTerminalStatus();
	};

	const clearBackgroundTerminalStatus = () => {
		clearBackgroundTerminalWidget();
		statusUi?.setStatus(BACKGROUND_TERMINAL_STATUS_KEY, undefined);
		statusUi = undefined;
		lastBackgroundTerminalStatus = undefined;
	};

	function installForegroundExecInterrupt(ctx: ExtensionContext): void {
		uninstallForegroundExecInterrupt?.();
		const onTerminalInput = ctx.ui?.onTerminalInput;
		if (!onTerminalInput) {
			uninstallForegroundExecInterrupt = undefined;
			return;
		}
		uninstallForegroundExecInterrupt = onTerminalInput((data) => {
			if (foregroundExecToolCalls.size === 0 || !matchesKey(data, Key.escape)) return undefined;
			ctx.abort();
			ctx.ui.notify("Interrupting foreground exec_command...", "info");
			return { consume: true };
		});
	}

	function clearForegroundExecInterrupt(): void {
		uninstallForegroundExecInterrupt?.();
		uninstallForegroundExecInterrupt = undefined;
		foregroundExecToolCalls.clear();
	}

	registerExecCommandTool(pi, tracker, sessions, {
		onResult: (input, result, _ctx, captureContext) => {
			if (result.process_id === undefined) return;
			completionMessageSessions.add(result.process_id);
			backgroundTerminalShells.set(result.process_id, resolveRuntimeShell(input.shell ?? process.env.SHELL));
			if (captureContext) backgroundCaptureContexts.set(result.process_id, captureContext);
		},
		contextGuardEnabled: isExecCommandContextGuardEnabled,
		getOriginalCommand: (toolCallId, executedCommand) => originalCommands.get(toolCallId)?.get(executedCommand),
	});
	registerWriteStdinTool(pi, sessions, {
		onResult: (input, result) => {
			if (isTerminalExecResult(result)) {
				cancelBackgroundTerminalCompletionMessage(input.process_id);
				const captureFailure = backgroundCaptureFailures.get(input.process_id);
				if (captureFailure) {
					result.context_guard_capture_failure = captureFailure;
					backgroundCaptureFailures.delete(input.process_id);
				}
			}
		},
	});
	registerProcessLogsTool(pi, sessions);
	registerProcessControlTools(pi, sessions);
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
				timed_out: snapshot.timedOut,
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
				await captureExecResult(captureContext, details);
			}
			if (agentTurnActive && details.context_guard_capture_failure) {
				backgroundCaptureFailures.set(sessionId, details.context_guard_capture_failure);
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
		updateBackgroundTerminalStatus();
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
			setBackgroundTerminalStatusUi(ctx);
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
		currentExecCtx = ctx;
		if (ctx.hasUI) {
			unregisterHubSource?.();
			unregisterHubSource = registerRuntimeHubSource("exec-command", hubSource);
		}
		shuttingDown = false;
		agentTurnActive = false;
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "resume" || reason === "new" || reason === "fork") {
			clearBackgroundTerminalStatus();
			sessions.shutdown();
		}
		installForegroundExecInterrupt(ctx);
		setBackgroundTerminalStatusUi(ctx);
		tracker.clear();
		completionMessageSessions.clear();
		backgroundCaptureContexts.clear();
		backgroundCaptureFailures.clear();

		originalCommands.clear();
		clearPendingBackgroundTerminalCompletionMessages();
		syncToolPolicy();
	});
	pi.on("session_tree", () => {
		agentTurnActive = false;
		tracker.clear();
		completionMessageSessions.clear();
		backgroundCaptureContexts.clear();
		backgroundCaptureFailures.clear();

		originalCommands.clear();
		clearPendingBackgroundTerminalCompletionMessages();
		syncToolPolicy();
	});
	pi.on("model_select", () => {
		syncToolPolicy();
	});
	pi.on("agent_start", () => {
		agentTurnActive = true;
		syncToolPolicy();
	});
	pi.on("agent_end", () => {
		agentTurnActive = false;
		syncToolPolicy();
	});
	pi.on("before_agent_start", () => {
		syncToolPolicy();
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		return {
			block: true,
			reason: "bash is disabled. Use exec_command instead.",
		};
	});
	pi.on("tool_call", async (event, ctx) => {
		if (
			!isToolCallEventType<"exec_command", { cmd?: unknown; commands?: unknown[] }>("exec_command", event) ||
			process.env.RTK_DISABLED === "1" ||
			!(await rtkAvailable)
		) {
			return;
		}
		const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
		const originals = typeof toolCallId === "string" ? new Map<string, string>() : undefined;
		const rewrite = async (command: string): Promise<string> => {
			if (!command.trim() || command.startsWith("rtk ")) return command;
			try {
				const rewritten = (await rewriteCommandWithRtk(pi, command, ctx.signal)) || command;
				if (rewritten !== command) originals?.set(rewritten, command);
				return rewritten;
			} catch (error) {
				console.warn("[rtk] rewrite failed; passing through command", error);
				return command;
			}
		};

		if (typeof event.input.cmd === "string") {
			event.input.cmd = await rewrite(event.input.cmd);
		} else if (Array.isArray(event.input.commands)) {
			event.input.commands = await Promise.all(
				event.input.commands.map(async (item) => {
					if (typeof item === "string") return rewrite(item);
					if (!item || typeof item !== "object") return item;
					const command = (item as Record<string, unknown>).command;
					return typeof command === "string" ? { ...item, command: await rewrite(command) } : item;
				}),
			);
		}
		if (originals && originals.size > 0 && typeof toolCallId === "string") {
			originalCommands.set(toolCallId, originals);
		}
	});
	pi.on("tool_execution_start", (event, ctx) => {
		setBackgroundTerminalStatusUi(ctx);
		if (event.toolName !== "exec_command") return;
		foregroundExecToolCalls.add(event.toolCallId);
		const command = getCommandArg(event.args);
		if (command) tracker.recordStart(event.toolCallId, command);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "exec_command") {
			foregroundExecToolCalls.delete(event.toolCallId);
			tracker.recordEnd(event.toolCallId);
			originalCommands.delete(event.toolCallId);
		}
	});
	pi.on("tool_result", (event) => {
		const content = truncateTextToolResultContent(event.content);
		const patch: { content?: unknown[]; isError?: boolean } = {};
		if (content) patch.content = content;

		if (event.toolName === "exec_command" || event.toolName === "write_stdin") {
			const details = event.details;
			if (details && typeof details === "object") {
				const resultDetails = details as {
					exit_code?: unknown;
					timed_out?: unknown;
					cancelled?: unknown;
					session_error?: unknown;
				};
				if (
					(typeof resultDetails.exit_code === "number" && resultDetails.exit_code !== 0) ||
					resultDetails.timed_out === true ||
					resultDetails.cancelled === true ||
					typeof resultDetails.session_error === "string"
				) {
					patch.isError = true;
				}
			}
		}

		return Object.keys(patch).length > 0 ? patch : undefined;
	});
	pi.on("session_shutdown", () => {
		unregisterHubSource?.();
		unregisterHubSource = undefined;
		currentExecCtx = undefined;
		agentTurnActive = false;
		shuttingDown = true;
		completionMessageSessions.clear();
		backgroundCaptureFailures.clear();
		clearPendingBackgroundTerminalCompletionMessages();
		clearForegroundExecInterrupt();
		clearBackgroundTerminalStatus();
		tracker.clear();
		sessions.shutdown();
	});
}
