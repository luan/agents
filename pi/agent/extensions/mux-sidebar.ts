import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type MuxPiState = {
	version: 1;
	agent: "pi";
	paneId: string;
	pid: number;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	provider?: string;
	model?: string;
	updatedAtMs: number;
	lastActivityAtMs: number;
	activity?: string;
	asking: boolean;
	ctx?: {
		pct: number;
		tokens: string;
	};
};

type RuntimeState = {
	activity?: string;
	asking: boolean;
	lastActivityAtMs: number;
	phase: "idle" | "working" | "waiting";
};

function stateDir(): string {
	const base = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state");
	return join(base, "mux", "pi-agents");
}

function paneId(): string | undefined {
	return process.env.TMUX_PANE;
}

function statePath(): string | undefined {
	const pane = paneId();
	if (!pane) return undefined;
	return join(stateDir(), `${pane.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function compactCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "";
	if (value >= 950_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 950) {
		const k = value / 1_000;
		if (k >= 100) return `${Math.round(k)}k`;
		return Number.isInteger(k) ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
	}
	return `${Math.round(value)}`;
}

function contextSnapshot(ctx: ExtensionContext): MuxPiState["ctx"] | undefined {
	const usage = ctx.getContextUsage();
	const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
	const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
	if (percent === undefined && contextWindow <= 0) return undefined;

	const used = percent !== undefined && contextWindow > 0 ? Math.round((percent / 100) * contextWindow) : 0;
	const tokens =
		contextWindow > 0 && percent !== undefined
			? `${compactCount(used)}/${compactCount(contextWindow)}`
			: compactCount(contextWindow || used);

	return {
		pct: Math.round(Math.max(0, Math.min(100, percent ?? 0))),
		tokens,
	};
}

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

export default function muxSidebarExtension(pi: ExtensionAPI) {
	const file = statePath();
	if (!file) return;

	const runtime: RuntimeState = {
		asking: false,
		lastActivityAtMs: Date.now(),
		phase: "idle",
	};

	let latestCtx: ExtensionContext | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let lastSidebarSyncAtMs = 0;

	const writeState = (ctx = latestCtx) => {
		try {
			if (!ctx) return;
			latestCtx = ctx;
			const pane = paneId();
			if (!pane) return;

			const snapshot: MuxPiState = {
				version: 1,
				agent: "pi",
				paneId: pane,
				pid: process.pid,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
				sessionName: sessionName(pi),
				provider: ctx.model?.provider,
				model: ctx.model?.name ?? ctx.model?.id,
				updatedAtMs: Date.now(),
				lastActivityAtMs: runtime.lastActivityAtMs,
				activity: runtime.activity,
				asking: runtime.asking,
				ctx: contextSnapshot(ctx),
			};

			mkdirSync(stateDir(), { recursive: true });
			writeFileSync(file, `${JSON.stringify(snapshot)}\n`, "utf-8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("ctx is stale")) console.error(`[mux-sidebar] ${message}`);
		}
	};

	const notify = (notificationType: "idle_prompt" | "elicitation_dialog", message: string) => {
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

	const syncSidebar = () => {
		const now = Date.now();
		if (now - lastSidebarSyncAtMs < 750) return;
		lastSidebarSyncAtMs = now;
		const child = spawn("mux", ["sidebar", "sync"], {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {});
		child.unref();
	};

	const markWorking = (ctx: ExtensionContext, activity = "Thinking…") => {
		runtime.activity = activity;
		runtime.asking = false;
		runtime.lastActivityAtMs = Date.now();
		runtime.phase = "working";
		writeState(ctx);
		syncSidebar();
	};

	const markWaiting = (ctx: ExtensionContext) => {
		const shouldNotify = runtime.phase !== "waiting";
		runtime.activity = "Waiting";
		runtime.asking = true;
		runtime.phase = "waiting";
		writeState(ctx);
		syncSidebar();
		if (shouldNotify) notify("elicitation_dialog", "Pi has a question for you");
	};

	const markIdle = (ctx: ExtensionContext, options: { notify?: boolean } = {}) => {
		const shouldNotify = options.notify && runtime.phase !== "idle";
		runtime.activity = undefined;
		runtime.asking = false;
		runtime.phase = "idle";
		writeState(ctx);
		syncSidebar();
		if (shouldNotify) notify("idle_prompt", "Pi is idle and waiting for your input");
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		markIdle(ctx);
		heartbeat ??= setInterval(() => writeState(), 2_000);
	});

	pi.on("agent_start", async (_event, ctx) => markWorking(ctx, "Thinking…"));
	pi.on("turn_start", async (_event, ctx) => markWorking(ctx, "Thinking…"));
	pi.on("message_update", async (_event, ctx) => markWorking(ctx, "Writing…"));
	pi.on("tool_execution_start", async (event, ctx) => {
		if (isAskUserTool(event.toolName)) {
			markWaiting(ctx);
		} else {
			markWorking(ctx, "Working…");
		}
	});
	pi.on("tool_execution_end", async (_event, ctx) => markWorking(ctx, "Thinking…"));
	pi.on("message_end", async (_event, ctx) => writeState(ctx));
	pi.on("model_select", async (_event, ctx) => writeState(ctx));
	pi.on("session_compact", async (_event, ctx) => writeState(ctx));
	pi.on("agent_end", async (_event, ctx) => markIdle(ctx, { notify: true }));
	pi.events.on("ask:waiting:start", () => {
		if (latestCtx) markWaiting(latestCtx);
	});
	pi.events.on("ask:waiting:end", () => {
		if (latestCtx) markWorking(latestCtx, "Thinking…");
	});

	pi.on("session_shutdown", async () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = undefined;
		}
		rmSync(file, { force: true });
	});
}
