import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCommand } from "../shared/ct-runner";
import { terminalRows } from "../shared/terminal";
import { ensureConfigExists, loadConfig, type PolishedTuiConfig } from "./config";
import { installFocusCursor } from "./cursor-focus";
import { installEditorComposition } from "./editor";
import {
	emptyFooterState,
	estimateContextBreakdown,
	type FooterRenderState,
	renderFooter,
	scaleContextSegmentsToUsage,
	scaleContextSlicesToUsage,
} from "./footer";
import { readGitStatus } from "./git";
import { readRuntimeInfo } from "./runtime";
import { patchUserMessageComponent } from "./transcript";
import { detectUsageProvider, fetchUsageForProvider, USAGE_REFRESH_INTERVAL, type UsageSnapshot } from "./usage";

type UsageTotals = { input: number; output: number; cost: number };

type UsageBarCache = {
	key: string;
	lines: string[];
};

const CONTEXT_PULSE_INTERVAL_MS = 320;
const CONTEXT_PULSE_DURATION_MS = 1200;

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
	};
	return known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
	let contextPulseTimer: ReturnType<typeof setInterval> | null = null;
	const contextPulseDeadlines = new Map<number, number>();
	let disposed = false;
	let uiGeneration = 0;

	const isStaleCtxError = (error: unknown) =>
		(error instanceof Error ? error.message : String(error)).includes("ctx is stale");
	const isCurrent = (generation: number) => !disposed && generation === uiGeneration;

	const refresh = () => {
		if (!disposed) requestFooterRender?.();
	};

	const stopContextPulse = () => {
		if (contextPulseTimer) {
			clearInterval(contextPulseTimer);
			contextPulseTimer = null;
		}
		state.contextPulseSliceIndexes = [];
		state.contextPulseFrame = 0;
		contextPulseDeadlines.clear();
	};

	const activePulseIndexes = () => {
		const now = Date.now();
		for (const [index, deadline] of contextPulseDeadlines) {
			if (deadline <= now || index >= state.contextSlices.length) contextPulseDeadlines.delete(index);
		}
		return [...contextPulseDeadlines.keys()].sort((a: number, b: number) => a - b);
	};

	const pulseContextSliceIndexes = (indexes: readonly number[]) => {
		if (indexes.length === 0) return;
		const deadline = Date.now() + CONTEXT_PULSE_DURATION_MS;
		for (const index of indexes) {
			if (index >= 0 && index < state.contextSlices.length) contextPulseDeadlines.set(index, deadline);
		}
		state.contextPulseSliceIndexes = activePulseIndexes();
		if (contextPulseTimer) return;

		contextPulseTimer = setInterval(() => {
			if (disposed) {
				stopContextPulse();
				refresh();
				return;
			}
			state.contextPulseSliceIndexes = activePulseIndexes();
			if (state.contextPulseSliceIndexes.length === 0) {
				stopContextPulse();
				refresh();
				return;
			}
			state.contextPulseFrame++;
			refresh();
		}, CONTEXT_PULSE_INTERVAL_MS);
	};

	const pulseLastContextSlicesForMessage = (message: unknown) => {
		const pulseSliceCount = estimateContextBreakdown([message], "").slices.length;
		if (pulseSliceCount <= 0) return;
		const start = Math.max(0, state.contextSlices.length - pulseSliceCount);
		pulseContextSliceIndexes(Array.from({ length: state.contextSlices.length - start }, (_, index) => start + index));
	};

	const isCompactTerminal = () => {
		const rows = terminalRows();
		return rows !== undefined && rows < currentConfig.compact.minTerminalRows;
	};

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
			["tui", "usage-bar", "--width", String(width)],
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

	const syncState = (ctx: ExtensionContext, activeMessage?: unknown) => {
		const totals = getUsageTotals(ctx);
		const usage = ctx.getContextUsage();
		const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
		const measuredContextTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
		const contextMessages = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		).messages;
		const rawContext = estimateContextBreakdown(
			activeMessage ? [...contextMessages, activeMessage] : contextMessages,
			ctx.getSystemPrompt(),
		);
		const rawContextSegments = rawContext.segments;
		const estimatedContextTokens = Object.values(rawContextSegments).reduce((total, value) => total + value, 0);
		const storedContextUsed =
			measuredContextTokens ??
			(usage && contextWindow > 0 && usage.percent !== null
				? Math.round((usage.percent / 100) * contextWindow)
				: estimatedContextTokens);
		const contextUsed =
			activeMessage && measuredContextTokens !== undefined
				? Math.max(measuredContextTokens, estimatedContextTokens)
				: storedContextUsed;
		const scaledSlices = scaleContextSlicesToUsage(rawContext.slices, contextUsed);

		state.modelLabel = ctx.model?.name ?? "no-model";
		state.providerLabel = formatProviderLabel(ctx.model?.provider);
		state.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
		state.contextPercent = usage?.percent ?? (contextWindow > 0 ? (contextUsed / contextWindow) * 100 : null);
		state.contextTotal = contextWindow;
		state.contextUsed = contextUsed;
		state.contextSegments = scaleContextSegmentsToUsage(rawContextSegments, contextUsed);
		state.contextSlices = scaledSlices;
		if (activeMessage && scaledSlices.length > 0) {
			pulseLastContextSlicesForMessage(activeMessage);
		}
		state.contextUsageEstimated = measuredContextTokens === undefined;
		state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
		state.costLabel = `$${totals.cost.toFixed(2)}`;
		state.hasTokens = totals.input > 0 || totals.output > 0;
		state.hasCost = totals.cost > 0;
	};

	const syncStateIfCurrent = (ctx: ExtensionContext, activeMessage?: unknown) => {
		if (disposed) return false;
		try {
			syncState(ctx, activeMessage);
			return true;
		} catch (error) {
			if (isStaleCtxError(error)) return false;
			throw error;
		}
	};

	const refreshProjectState = async (ctx: ExtensionContext, generation: number) => {
		const [gitStatus, runtime] = await Promise.all([readGitStatus(ctx.cwd), readRuntimeInfo(ctx.cwd)]);
		if (!isCurrent(generation)) return;
		Object.assign(state, gitStatus);
		state.runtime = runtime;
	};

	const scheduleProjectRefresh = (ctx: ExtensionContext, generation = uiGeneration) => {
		if (!isCurrent(generation)) return;
		if (projectRefreshInFlight) {
			projectRefreshPending = true;
			return;
		}
		projectRefreshInFlight = true;
		void refreshProjectState(ctx, generation).finally(() => {
			projectRefreshInFlight = false;
			if (isCurrent(generation)) refresh();
			if (projectRefreshPending) {
				projectRefreshPending = false;
				scheduleProjectRefresh(ctx, generation);
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
		if (disposed) return;
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
		const generation = uiGeneration;
		const cwd = ctx.cwd;
		syncStateIfCurrent(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const disposeFocusCursor = installFocusCursor(pi, ctx, tui);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleProjectRefresh(ctx, generation);
				tui.requestRender();
			});

			if (ctx.model?.provider) {
				fetchUsage(ctx.model.provider);
				startRefreshTimer();
			}

			return {
				dispose: () => {
					disposeFocusCursor();
					unsubscribeBranch();
					requestFooterRender = undefined;
					stopRefreshTimer();
					stopContextPulse();
				},
				invalidate() {},
				render(width: number): string[] {
					if (isCompactTerminal()) return renderFooter(state, currentConfig, cwd, theme, width, { minimal: true });
					ensureUsageBarLines(width);
					return renderFooter(state, currentConfig, cwd, theme, width);
				},
			};
		});
	};

	const installEditor = (ctx: ExtensionContext) => {
		syncStateIfCurrent(ctx);
		installEditorComposition(ctx.ui.theme, currentConfig.compact.minTerminalRows);
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
		disposed = false;
		uiGeneration++;
		installUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		uiGeneration++;
		requestFooterRender = undefined;
		stopRefreshTimer();
		stopContextPulse();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("model_select", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		if (event.model?.provider) {
			fetchUsage(event.model.provider);
			startRefreshTimer();
		}
		refresh();
	});

	pi.on("message_end", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		pulseLastContextSlicesForMessage(event.message);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("message_update", async (event, ctx) => {
		if (!syncStateIfCurrent(ctx, event.message)) return;
		refresh();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});
}
