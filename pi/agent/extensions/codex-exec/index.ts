import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
import { formattedTruncateText } from "./tools/output-truncation.ts";
import { computeRtkRewriteDecision, type RtkWrapperState } from "./tools/rtk-wrapper.ts";
import { registerWriteStdinTool } from "./tools/write-stdin-tool.ts";

function isCodexModel(model: ExtensionContext["model"] | undefined): boolean {
	const provider = model?.provider?.toLowerCase() ?? "";
	const id = model?.id?.toLowerCase() ?? "";
	return provider.includes("codex") || id.includes("codex");
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
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

export default function codexExecExtension(pi: ExtensionAPI) {
	const tracker = createExecCommandTracker();
	const sessions = createExecSessionManager();
	const toolsRemovedForCodex = new Set<string>();
	const rtk: RtkWrapperState = { enabled: true };
	const rtkWarningsShown = new Set<string>();

	registerExecCommandTool(pi, tracker, sessions, {
		rewriteCommand: async (command, ctx) => {
			const decision = await computeRtkRewriteDecision(pi, command, rtk.enabled);
			if (decision.warning && ctx.hasUI && !rtkWarningsShown.has(decision.warning)) {
				rtkWarningsShown.add(decision.warning);
				ctx.ui.notify(`RTK rewrite skipped: ${decision.warning}`, "warning");
			}
			return decision.changed ? decision.rewrittenCommand : command;
		},
	});
	registerWriteStdinTool(pi, sessions);
	sessions.onSessionExit((sessionId) => tracker.recordSessionFinished(sessionId));

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

	const applyToolPolicy = (ctx?: ExtensionContext) => {
		if (!ctx) return;
		const active = pi.getActiveTools();
		const codex = isCodexModel(ctx.model);
		let next = active;
		if (codex) {
			next = active.filter((toolName) => {
				if (toolName === "bash") {
					toolsRemovedForCodex.add(toolName);
					return false;
				}
				return true;
			});
			for (const toolName of ["exec_command", "write_stdin"]) {
				if (!next.includes(toolName)) next.push(toolName);
			}
		} else {
			next = active.filter((toolName) => toolName !== "exec_command" && toolName !== "write_stdin");
			if (toolsRemovedForCodex.size > 0) {
				const registeredTools = new Set(
					((pi as any).getAllTools?.() ?? []).map((tool: { name?: string }) => tool.name),
				);
				for (const toolName of toolsRemovedForCodex) {
					if ((!registeredTools.size || registeredTools.has(toolName)) && !next.includes(toolName)) {
						next.push(toolName);
					}
				}
				toolsRemovedForCodex.clear();
			}
		}
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	pi.on("session_start", (_event, ctx) => {
		tracker.clear();
		applyToolPolicy(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		tracker.clear();
		applyToolPolicy(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		applyToolPolicy(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		applyToolPolicy(ctx);
	});
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "bash" && isCodexModel(ctx?.model)) {
			return {
				block: true,
				reason: "bash is disabled for Codex models. Use exec_command instead.",
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
		tracker.clear();
		sessions.shutdown();
	});
}
