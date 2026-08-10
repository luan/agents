import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function sessionName(pi: ExtensionAPI): string | undefined {
	try {
		return pi.getSessionName();
	} catch {
		return undefined;
	}
}

function isAskUserTool(toolName: string): boolean {
	return toolName === "ask_user" || toolName.endsWith(".ask_user");
}

export function isSubagentSessionFile(sessionFile: string | undefined): boolean {
	return sessionFile?.replaceAll("\\", "/").includes("/sessions/subagents/") ?? false;
}

export default function notificationsExtension(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let phase: "idle" | "working" | "waiting" = "idle";

	const notify = (ctx: ExtensionContext, notificationType: "idle_prompt" | "elicitation_dialog", message: string) => {
		if (isSubagentSessionFile(ctx.sessionManager.getSessionFile() ?? undefined)) return;
		const child = spawn("ct", ["notify"], {
			stdio: ["pipe", "ignore", "ignore"],
			detached: true,
		});
		child.on("error", () => {});
		child.stdin?.end(
			`${JSON.stringify({
				title: sessionName(pi) ?? "Pi",
				agent: "Pi",
				message,
				notification_type: notificationType,
			})}\n`,
		);
		child.unref();
	};

	const markWaiting = (ctx: ExtensionContext) => {
		if (phase === "waiting") return;
		phase = "waiting";
		notify(ctx, "elicitation_dialog", "Pi has a question for you");
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		phase = "idle";
	});
	pi.on("agent_start", async () => {
		phase = "working";
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (isAskUserTool(event.toolName)) markWaiting(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (phase === "idle") return;
		phase = "idle";
		notify(ctx, "idle_prompt", "Pi is idle and waiting for your input");
	});
	pi.events.on("ask:waiting:start", () => {
		if (latestCtx) markWaiting(latestCtx);
	});
	pi.events.on("ask:waiting:end", () => {
		phase = "working";
	});
	pi.on("session_shutdown", async () => {
		latestCtx = undefined;
	});
}
