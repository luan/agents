import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createExecCommandTracker } from "./tools/exec-command-state.ts";
import { registerExecCommandTool } from "./tools/exec-command-tool.ts";
import { createExecSessionManager } from "./tools/exec-session-manager.ts";
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
  return message.content.every((item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall");
}

export default function codexExecExtension(pi: ExtensionAPI) {
  const tracker = createExecCommandTracker();
  const sessions = createExecSessionManager();

  registerExecCommandTool(pi, tracker, sessions);
  registerWriteStdinTool(pi, sessions);
  sessions.onSessionExit((sessionId) => tracker.recordSessionFinished(sessionId));

  const applyToolPolicy = (ctx?: ExtensionContext) => {
    if (!ctx) return;
    const active = pi.getActiveTools();
    const codex = isCodexModel(ctx.model);
    let next = active;
    if (codex) {
      next = [...next];
      for (const toolName of ["exec_command", "write_stdin"]) {
        if (!next.includes(toolName)) next.push(toolName);
      }
    } else {
      next = active.filter((toolName) => toolName !== "exec_command" && toolName !== "write_stdin");
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
  pi.on("session_shutdown", () => {
    tracker.clear();
    sessions.shutdown();
  });
}
