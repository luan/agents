import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { runCommand } from "../shared/ct-runner";
import {
  type PolishedTuiConfig,
  ensureConfigExists,
  loadConfig,
} from "./config";
import { emptyFooterState, type FooterRenderState, renderFooter } from "./footer";
import { readGitStatus } from "./git";
import { readRuntimeInfo } from "./runtime";
import { PolishedEditor, patchUserMessageComponent } from "./ui";
import {
  USAGE_REFRESH_INTERVAL,
  detectUsageProvider,
  fetchUsageForProvider,
  type UsageSnapshot,
} from "./usage";

type UsageTotals = { input: number; output: number; cost: number };

type UsageBarCache = {
  key: string;
  lines: string[];
};

function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
  if (!provider) return "Unknown";
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    "claude-agent-sdk": "Anthropic",
    gemini: "Google",
    google: "Google",
    ollama: "Ollama",
    openai: "OpenAI",
    "openai-codex": "OpenAI",
  };
  return (
    known[provider] ??
    provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function providerColor(providerLabel: string): string | undefined {
  switch (providerLabel) {
    case "Anthropic":
      return "d87b4a";
    case "OpenAI":
      return "74c7ec";
    case "Copilot":
      return "cba6f7";
    case "Google":
      return "a6e3a1";
    case "MiniMax":
    case "MiniMax CN":
      return "fab387";
    default:
      return undefined;
  }
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    input += message.usage?.input ?? 0;
    output += message.usage?.output ?? 0;
    cost += message.usage?.cost?.total ?? 0;
  }
  return { input, output, cost };
}

export default function (pi: ExtensionAPI) {
  const state: FooterRenderState = emptyFooterState();
  const usageCache = new Map<string, UsageSnapshot>();

  let currentConfig: PolishedTuiConfig = loadConfig();
  let requestFooterRender: (() => void) | undefined;
  let projectRefreshInFlight = false;
  let projectRefreshPending = false;

  let activeProvider: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let usageBarCache: UsageBarCache | null = null;
  let usageBarPendingKey: string | null = null;

  const refresh = () => requestFooterRender?.();

  const usageBarKey = (width: number): string =>
    JSON.stringify({
      width,
      provider: state.providerLabel,
      fetchedAt: state.usage?.fetchedAt ?? 0,
      windows: state.usage?.windows ?? [],
    });

  const ensureUsageBarLines = (width: number) => {
    const key = usageBarKey(width);
    if (usageBarCache?.key === key) {
      state.usageLines = usageBarCache.lines;
      return;
    }

    if (!state.usage?.windows.length) {
      state.usageLines = undefined;
      usageBarCache = null;
      usageBarPendingKey = null;
      return;
    }

    if (usageBarPendingKey === key) return;
    usageBarPendingKey = key;

    const request = {
      provider_label: state.providerLabel,
      provider_color: providerColor(state.providerLabel),
      windows: state.usage.windows.map((w) => ({
        label: w.label,
        used_percent: w.usedPercent,
        window_secs: w.windowSecs,
        reset_secs: w.resetSecs,
      })),
      width,
    };

    void runCommand(
      "ct",
      ["usage-bar", "--width", String(width)],
      process.cwd(),
      undefined,
      JSON.stringify(request),
    )
      .then((result) => {
        if (usageBarPendingKey !== key) return;
        usageBarPendingKey = null;
        const lines = result.stdout.split(/\r?\n/).filter(Boolean);
        usageBarCache = { key, lines };
        state.usageLines = lines;
        refresh();
      })
      .catch(() => {
        if (usageBarPendingKey !== key) return;
        usageBarPendingKey = null;
        usageBarCache = null;
        state.usageLines = undefined;
        refresh();
      });
  };

  const syncState = (ctx: ExtensionContext) => {
    const totals = getUsageTotals(ctx);
    const usage = ctx.getContextUsage();
    const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;

    state.modelLabel = ctx.model?.name ?? "no-model";
    state.providerLabel = formatProviderLabel(ctx.model?.provider);
    state.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
    state.contextPercent = usage?.percent ?? null;
    state.contextTotal = contextWindow;
    state.contextUsed =
      usage && contextWindow > 0 && usage.percent !== null
        ? Math.round((usage.percent / 100) * contextWindow)
        : 0;
    state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
    state.costLabel = `$${totals.cost.toFixed(2)}`;
    state.hasTokens = totals.input > 0 || totals.output > 0;
    state.hasCost = totals.cost > 0;
  };

  const refreshProjectState = async (ctx: ExtensionContext) => {
    const [gitStatus, runtime] = await Promise.all([
      readGitStatus(ctx.cwd),
      readRuntimeInfo(ctx.cwd),
    ]);
    Object.assign(state, gitStatus);
    state.runtime = runtime;
  };

  const scheduleProjectRefresh = (ctx: ExtensionContext) => {
    if (projectRefreshInFlight) {
      projectRefreshPending = true;
      return;
    }
    projectRefreshInFlight = true;
    void refreshProjectState(ctx).finally(() => {
      projectRefreshInFlight = false;
      refresh();
      if (projectRefreshPending) {
        projectRefreshPending = false;
        scheduleProjectRefresh(ctx);
      }
    });
  };

  const stopRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  const applyUsageResult = (provider: string, snapshot: UsageSnapshot) => {
    if (activeProvider !== provider) return;
    const cached = usageCache.get(provider);
    if (snapshot.windows.length === 0 && snapshot.error && cached?.windows.length) return;
    usageCache.set(provider, snapshot);
    state.usage = snapshot;
    state.usageLines = undefined;
    usageBarCache = null;
    usageBarPendingKey = null;
    refresh();
  };

  const fetchUsage = (modelProvider: string | undefined) => {
    const provider = detectUsageProvider(modelProvider);
    if (!provider) {
      activeProvider = null;
      state.usage = null;
      state.usageLines = undefined;
      usageBarCache = null;
      usageBarPendingKey = null;
      stopRefreshTimer();
      refresh();
      return;
    }

    activeProvider = provider;
    const cached = usageCache.get(provider);
    if (cached && cached.windows.length > 0) {
      state.usage = cached;
      state.usageLines = undefined;
      usageBarCache = null;
      usageBarPendingKey = null;
      refresh();
    } else {
      state.usage = null;
      state.usageLines = undefined;
      usageBarCache = null;
      usageBarPendingKey = null;
      refresh();
    }

    fetchUsageForProvider(provider)
      .then((snapshot) => applyUsageResult(provider, snapshot))
      .catch(() => {});
  };

  const startRefreshTimer = () => {
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      if (!activeProvider) return;
      const provider = activeProvider;
      fetchUsageForProvider(provider)
        .then((snapshot) => applyUsageResult(provider, snapshot))
        .catch(() => {});
    }, USAGE_REFRESH_INTERVAL);
  };

  const installFooter = (ctx: ExtensionContext) => {
    syncState(ctx);

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => {
        scheduleProjectRefresh(ctx);
        tui.requestRender();
      });

      if (ctx.model?.provider) {
        fetchUsage(ctx.model.provider);
        startRefreshTimer();
      }

      return {
        dispose: () => {
          unsubscribeBranch();
          requestFooterRender = undefined;
          stopRefreshTimer();
        },
        invalidate() {},
        render(width: number): string[] {
          ensureUsageBarLines(width);
          return renderFooter(state, currentConfig, ctx.cwd, theme, width);
        },
      };
    });
  };

  const installEditor = (ctx: ExtensionContext) => {
    syncState(ctx);

    let currentEditor: PolishedEditor | undefined;
    let autocompleteFixed = false;

    type AutocompleteEditorInternals = { autocompleteProvider?: unknown };

    const editorFactory = (
      tui: TUI,
      theme: EditorTheme,
      keybindings: KeybindingsManager,
    ) => {
      const editor = new PolishedEditor(
        tui,
        theme,
        keybindings,
        ctx.ui.theme,
      );
      currentEditor = editor;

      const originalHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        const internals = editor as unknown as AutocompleteEditorInternals;
        if (!autocompleteFixed && !internals.autocompleteProvider) {
          autocompleteFixed = true;
          ctx.ui.setEditorComponent(editorFactory);
          currentEditor?.handleInput(data);
          return;
        }
        originalHandleInput(data);
      };

      return editor;
    };

    ctx.ui.setEditorComponent(editorFactory);
  };

  const installUi = (ctx: ExtensionContext) => {
    ensureConfigExists();
    currentConfig = loadConfig();
    patchUserMessageComponent(ctx.ui.theme);
    installFooter(ctx);
    installEditor(ctx);
    scheduleProjectRefresh(ctx);
    refresh();
  };

  pi.on("session_start", async (_event, ctx) => {
    installUi(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    syncState(ctx);
    refresh();
  });

  pi.on("agent_end", async (_event, ctx) => {
    syncState(ctx);
    scheduleProjectRefresh(ctx);
    refresh();
  });

  pi.on("model_select", async (event, ctx) => {
    syncState(ctx);
    if (event.model?.provider) {
      fetchUsage(event.model.provider);
      startRefreshTimer();
    }
    refresh();
  });

  pi.on("message_end", async (_event, ctx) => {
    syncState(ctx);
    scheduleProjectRefresh(ctx);
    refresh();
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    syncState(ctx);
    scheduleProjectRefresh(ctx);
    refresh();
  });

  pi.on("session_compact", async (_event, ctx) => {
    syncState(ctx);
    scheduleProjectRefresh(ctx);
    refresh();
  });
}
