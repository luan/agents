import {
	BashExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveCoreBin } from "../context-guard/pi/core.ts";
import { isExecCommandContextGuardEnabled } from "../context-guard/pi/index.ts";
import { setOrderedAboveEditorWidget } from "../shared/ordered-widgets";
import {
	type RenderTheme,
	rawCommandToExecCell,
	renderBackgroundTerminalHud,
	renderExecCell,
	renderExecCellComponent,
} from "./tools/exec-cell-presentation.ts";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager, type ExecSessionRecord } from "./tools/exec-session-manager.ts";
import { formattedTruncateText } from "./tools/output-truncation.ts";
import { computeRtkRewriteDecision, type RtkWrapperState } from "./tools/rtk-wrapper.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";
import { BackgroundTerminalOverlay } from "./ui/background-terminal-overlay.ts";

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

function isToolCallOnlyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return false;
	if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) return false;
	return message.content.every(
		(item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall",
	);
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

function parseBooleanToggleArgument(args: string): boolean | undefined | "invalid" {
	const arg = args.trim().toLowerCase();
	if (!arg) return undefined;
	if (arg === "on" || arg === "true" || arg === "enable" || arg === "enabled") return true;
	if (arg === "off" || arg === "false" || arg === "disable" || arg === "disabled") return false;
	return "invalid";
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
const BACKGROUND_TERMINAL_HUD_FRAME_MS = 80;

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
	session_id: number;
	command: string;
	output: string;
	exit_code?: number;
	elapsed_ms: number;
	output_truncated: boolean;
	original_token_count?: number;
}

export default function execCommandExtension(pi: ExtensionAPI) {
	installEmptySelfShellRowPatch();
	installUserBashRenderPatch();
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const rtk: RtkWrapperState = { enabled: true };
	const contextGuard = { enabled: true };
	const rtkWarningsShown = new Set<string>();
	let shuttingDown = false;
	let statusUi: BackgroundTerminalStatusUi | undefined;
	let lastBackgroundTerminalStatus: string | undefined;
	let backgroundTerminalWidgetRegistered = false;
	let backgroundTerminalWidgetTui: { requestRender(): void } | undefined;
	let backgroundTerminalWidgetTimer: ReturnType<typeof setInterval> | undefined;
	const completionMessageSessions = new Map<number, { triggerTurn: boolean }>();

	(pi as any).registerMessageRenderer?.(
		EXEC_COMMAND_COMPLETED_MESSAGE,
		(
			message: { details?: BackgroundTerminalFinishedDetails },
			{ expanded }: { expanded: boolean },
			theme: RenderTheme,
		) => {
			const details = message.details;
			if (!details) return undefined;
			const failed = details.exit_code !== undefined && details.exit_code !== 0;
			return renderExecCellComponent(
				rawCommandToExecCell({
					command: details.command,
					status: "done",
					failed,
					outputBlock: {
						output: details.output,
						footer: failed ? theme.fg("muted", `Exit code: ${details.exit_code}`) : undefined,
						options: { expanded },
					},
				}),
				{ theme },
			);
		},
	);

	const syncToolPolicy = () => {
		if (shuttingDown) return;
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => toolName !== "bash");
		if (!next.includes("exec_command")) next.push("exec_command");
		if (!next.includes("write_stdin")) next.push("write_stdin");
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

	const renderBackgroundTerminalWidget = (theme: RenderTheme, width: number): string[] => {
		const runningRecords = sessions.listSessions().filter((record) => record.running);
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

	const renderBackgroundTerminalWidgetLine = (record: ExecSessionRecord, theme: RenderTheme, width: number): string =>
		renderBackgroundTerminalHud(
			{
				id: record.id,
				command: record.command,
				output: record.output,
				startedAtMs: record.startedAtMs,
				stdinOpen: record.stdinOpen,
			},
			{ theme, width },
		);

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
							backgroundTerminalWidgetRegistered = false;
							backgroundTerminalWidgetTui = undefined;
						},
					};
				},
			);
			backgroundTerminalWidgetRegistered = true;
		} else {
			backgroundTerminalWidgetTui?.requestRender();
		}
		if (!backgroundTerminalWidgetTimer) {
			backgroundTerminalWidgetTimer = setInterval(
				() => backgroundTerminalWidgetTui?.requestRender(),
				BACKGROUND_TERMINAL_HUD_FRAME_MS,
			);
			backgroundTerminalWidgetTimer.unref?.();
		}
	}

	function clearBackgroundTerminalWidget() {
		if (backgroundTerminalWidgetTimer) {
			clearInterval(backgroundTerminalWidgetTimer);
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

	registerExecCommandTool(pi, tracker, sessions, {
		rewriteCommand: async (command, ctx) => {
			const decision = await computeRtkRewriteDecision(pi, command, rtk.enabled);
			if (decision.warning && ctx.hasUI && !rtkWarningsShown.has(decision.warning)) {
				rtkWarningsShown.add(decision.warning);
				ctx.ui.notify(`RTK rewrite skipped: ${decision.warning}`, "warning");
			}
			return {
				command: decision.changed ? decision.rewrittenCommand : command,
				rtkWrapped: decision.usedRtk === true,
			};
		},
		onResult: (input, result) => {
			if (result.session_id !== undefined) {
				completionMessageSessions.set(result.session_id, { triggerTurn: input.wakeOnCompletion !== false });
			}
		},
		contextGuardEnabled: () =>
			contextGuard.enabled && isExecCommandContextGuardEnabled() && resolveCoreBin() !== null,
	});
	registerWriteStdinTool(pi, sessions);
	sessions.onSessionExit((sessionId, command) => {
		const snapshot = sessions.getSessionSnapshot(sessionId);
		tracker.recordSessionFinished(sessionId);
		const completionMessageSession = completionMessageSessions.get(sessionId);
		completionMessageSessions.delete(sessionId);
		if (!completionMessageSession) return;
		if (!snapshot) return;
		const details: BackgroundTerminalFinishedDetails = {
			session_id: sessionId,
			command,
			output: snapshot.output,
			exit_code: snapshot.exitCode,
			elapsed_ms: snapshot.elapsedMs,
			output_truncated: snapshot.outputTruncated,
		};
		if (snapshot.originalTokenCount !== undefined) {
			details.original_token_count = snapshot.originalTokenCount;
		}
		const deliveryOptions = completionMessageSession.triggerTurn
			? { deliverAs: "followUp", triggerTurn: true }
			: { triggerTurn: false };
		(pi as any).sendMessage?.(
			{
				customType: EXEC_COMMAND_COMPLETED_MESSAGE,
				content: "",
				display: true,
				details,
			},
			deliveryOptions,
		);
	});
	sessions.onSessionUpdate(updateBackgroundTerminalStatus);

	pi.registerCommand("rtk", {
		description: "Toggle RTK command wrapping for exec_command calls",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseBooleanToggleArgument(args);
			if (parsed === "invalid") {
				ctx.ui.notify("Usage: /rtk [on|off]", "error");
				return;
			}
			rtk.enabled = parsed ?? !rtk.enabled;
			ctx.ui.notify(`RTK wrapping ${rtk.enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("cg-wrap", {
		description: "Toggle Context Guard wrapping for exec_command calls",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseBooleanToggleArgument(args);
			if (parsed === "invalid") {
				ctx.ui.notify("Usage: /cg-wrap [on|off]", "error");
				return;
			}
			contextGuard.enabled = parsed ?? !contextGuard.enabled;
			ctx.ui.notify(`Context Guard wrapping ${contextGuard.enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.registerCommand("ps", {
		description: "list background terminals",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					return new BackgroundTerminalOverlay(sessions, tui, theme, done);
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", minWidth: 60 },
				},
			);
		},
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
		shuttingDown = false;
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "resume" || reason === "new" || reason === "fork") {
			clearBackgroundTerminalStatus();
			sessions.shutdown();
		}
		setBackgroundTerminalStatusUi(ctx);
		tracker.clear();
		completionMessageSessions.clear();
		syncToolPolicy();
	});
	pi.on("session_tree", () => {
		tracker.clear();
		completionMessageSessions.clear();
		syncToolPolicy();
	});
	pi.on("model_select", () => {
		syncToolPolicy();
	});
	pi.on("before_agent_start", () => {
		syncToolPolicy();
	});
	pi.on("tool_call", (event) => {
		if (event.toolName === "bash") {
			return {
				block: true,
				reason: "bash is disabled. Use exec_command instead.",
			};
		}
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		tracker.resetExplorationGroup();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		setBackgroundTerminalStatusUi(ctx);
		if (event.toolName !== "exec_command") {
			tracker.resetExplorationGroup();
			return;
		}
		const command = getCommandArg(event.args);
		if (command) tracker.recordStart(event.toolCallId, command);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "exec_command") tracker.recordEnd(event.toolCallId);
	});
	pi.on("tool_result", (event) => {
		const content = truncateTextToolResultContent(event.content);
		const patch: { content?: unknown[]; isError?: boolean } = {};
		if (content) patch.content = content;

		if (event.toolName === "exec_command" || event.toolName === "write_stdin") {
			const details = event.details;
			if (details && typeof details === "object" && "exit_code" in details) {
				const exitCode = (details as { exit_code?: unknown }).exit_code;
				if (typeof exitCode === "number" && exitCode !== 0) {
					patch.isError = true;
				}
			}
		}

		return Object.keys(patch).length > 0 ? patch : undefined;
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		completionMessageSessions.clear();
		clearBackgroundTerminalStatus();
		tracker.clear();
		sessions.shutdown();
	});
}
