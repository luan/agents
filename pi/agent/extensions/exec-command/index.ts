import { type ExtensionAPI, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { formattedTruncateText } from "./tools/output-truncation.ts";
import { computeRtkRewriteDecision, type RtkWrapperState } from "./tools/rtk-wrapper.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

const EMPTY_SELF_SHELL_ROW_PATCH = Symbol.for("agents.exec-command.empty-self-shell-row-patch");
const ANSI_PATTERN =
	/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*(?:\u001b\\)|_[^\u001b]*(?:\u001b\\)|\^[^\u001b]*(?:\u001b\\))/g;

interface ToolExecutionPrototype {
	render(width: number): string[];
	getRenderShell?(): "default" | "self";
	hasRendererDefinition?(): boolean;
	[EMPTY_SELF_SHELL_ROW_PATCH]?: true;
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

function parseRtkToggleArgument(args: string): boolean | undefined | "invalid" {
	const arg = args.trim().toLowerCase();
	if (!arg) return undefined;
	if (arg === "on" || arg === "true" || arg === "enable" || arg === "enabled") return true;
	if (arg === "off" || arg === "false" || arg === "disable" || arg === "disabled") return false;
	return "invalid";
}

export default function execCommandExtension(pi: ExtensionAPI) {
	installEmptySelfShellRowPatch();
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const rtk: RtkWrapperState = { enabled: true };
	const rtkWarningsShown = new Set<string>();
	let shuttingDown = false;

	const syncToolPolicy = () => {
		if (shuttingDown) return;
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => toolName !== "bash");
		if (!next.includes("exec_command")) next.push("exec_command");
		if (!next.includes("write_stdin")) next.push("write_stdin");
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
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
	});
	registerWriteStdinTool(pi, sessions);
	sessions.onSessionExit((sessionId) => {
		tracker.recordSessionFinished(sessionId);
	});

	pi.registerCommand("rtk", {
		description: "Toggle RTK command wrapping for exec_command calls",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseRtkToggleArgument(args);
			if (parsed === "invalid") {
				ctx.ui.notify("Usage: /rtk [on|off]", "error");
				return;
			}
			rtk.enabled = parsed ?? !rtk.enabled;
			ctx.ui.notify(`RTK wrapping ${rtk.enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.on("session_start", () => {
		shuttingDown = false;
		tracker.clear();
		syncToolPolicy();
	});
	pi.on("session_tree", () => {
		tracker.clear();
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
		if (event.toolName === "write_stdin" && !sessions.hasOpenInteractiveSession()) {
			return {
				block: true,
				reason: "write_stdin is disabled until exec_command opens a running TTY session.",
			};
		}
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		tracker.resetExplorationGroup();
	});
	pi.on("tool_execution_start", (event) => {
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
		tracker.clear();
		sessions.shutdown();
	});
}
