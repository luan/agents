import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type MuxPiState = {
  version: 1;
  agent: "pi";
  paneId: string;
  pid: number;
  cwd: string;
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
};

function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME ??
    join(process.env.HOME ?? ".", ".local", "state");
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
  const percent =
    typeof usage?.percent === "number" ? usage.percent : undefined;
  const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
  if (percent === undefined && contextWindow <= 0) return undefined;

  const used =
    percent !== undefined && contextWindow > 0
      ? Math.round((percent / 100) * contextWindow)
      : 0;
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

export default function muxSidebarExtension(pi: ExtensionAPI) {
  const file = statePath();
  if (!file) return;

  const runtime: RuntimeState = {
    asking: false,
    lastActivityAtMs: Date.now(),
  };

  let latestCtx: ExtensionContext | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

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
      if (!message.includes("ctx is stale"))
        console.error(`[mux-sidebar] ${message}`);
    }
  };

  const markWorking = (ctx: ExtensionContext, activity = "Thinking…") => {
    runtime.activity = activity;
    runtime.asking = false;
    runtime.lastActivityAtMs = Date.now();
    writeState(ctx);
  };

  const markIdle = (ctx: ExtensionContext) => {
    runtime.activity = undefined;
    runtime.asking = false;
    writeState(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    markIdle(ctx);
    heartbeat ??= setInterval(() => writeState(), 2_000);
  });

  pi.on("agent_start", async (_event, ctx) => markWorking(ctx, "Thinking…"));
  pi.on("turn_start", async (_event, ctx) => markWorking(ctx, "Thinking…"));
  pi.on("message_update", async (_event, ctx) => markWorking(ctx, "Writing…"));
  pi.on("tool_execution_start", async (_event, ctx) =>
    markWorking(ctx, "Working…"),
  );
  pi.on("tool_execution_end", async (_event, ctx) =>
    markWorking(ctx, "Thinking…"),
  );
  pi.on("message_end", async (_event, ctx) => writeState(ctx));
  pi.on("model_select", async (_event, ctx) => writeState(ctx));
  pi.on("session_compact", async (_event, ctx) => writeState(ctx));
  pi.on("agent_end", async (_event, ctx) => markIdle(ctx));

  pi.on("session_shutdown", async () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    rmSync(file, { force: true });
  });
}
