import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { runCommand } from "../shared/command-runner";
import {
	parseSubagentUsage,
	SUBAGENT_USAGE_ENTRY_TYPE,
	SUBAGENT_USAGE_EVENT,
	type SubagentUsageEvent,
} from "../shared/subagent-usage";
import {
	type AnimationMount,
	type AnimationRenderTarget,
	defineExtensionTui,
	sharedAnimationRenderScheduler,
} from "../shared/tui";
import { ensureConfigExists, loadConfig, type PolishedTuiConfig, saveConfig } from "./config";
import { installFocusCursor } from "./cursor-focus";
import {
	advanceWorkingAnimationFrame,
	type EditorSessionIdentity,
	getWorkingTimerSnapshot,
	installEditorComposition,
	resetWorkingTimerState,
	restoreWorkingTimerSnapshot,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingFastMode,
	setWorkingTimerStarted,
	setWorkingTimerStopped,
	WORKING_ANIMATION_INTERVAL_MS,
	type WorkingTimerSnapshot,
} from "./editor";
import {
	emptyFooterState,
	estimateContextSegments,
	type FooterRenderState,
	renderEditorContextStatus,
	renderEditorTopStatus,
	scaleContextSegmentsToUsage,
} from "./footer";
import { readGitStatus } from "./git";
import { readRuntimeInfo } from "./runtime";
import { installTranscriptSpacingPatch } from "./transcript-spacing";
import { detectUsageProvider, fetchUsageForProvider, USAGE_REFRESH_INTERVAL, type UsageSnapshot } from "./usage";

const polishedTui = defineExtensionTui({ id: "polished-tui" });

type FooterFactory = Parameters<ExtensionContext["ui"]["setFooter"]>[0];
type FooterDataProvider = Parameters<NonNullable<FooterFactory>>[2];
type UsageTotals = { input: number; output: number; cost: number };

type UsageBarCache = {
	key: string;
	lines: string[];
};

const WORKING_TIMER_ENTRY_TYPE = "tui:working-timer";
const MODEL_STATUS_KEYS = new Set(["openai-fast:active"]);

function cleanIdentityPart(value: string | undefined): string | undefined {
	const text = value
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function readModelStatusBadges(footerData: FooterDataProvider | undefined): string[] {
	if (!footerData) return [];
	const statuses = footerData.getExtensionStatuses();
	return [...MODEL_STATUS_KEYS]
		.map((key) => cleanIdentityPart(statuses.get(key)))
		.filter((status): status is string => Boolean(status));
}

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
		case "Google":
			return "a6e3a1";
		case "MiniMax":
		case "MiniMax CN":
			return "fab387";
		default:
			return undefined;
	}
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message as AssistantMessage;
			input += message.usage?.input ?? 0;
			output += message.usage?.output ?? 0;
			cost += message.usage?.cost?.total ?? 0;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_USAGE_ENTRY_TYPE) continue;
		const usage = parseSubagentUsage(entry.data);
		if (!usage) continue;
		input += usage.input;
		output += usage.output;
		cost += usage.cost;
	}
	return { input, output, cost };
}

function truncateUsageLine(line: string, width: number): string {
	return line ? truncateToWidth(line, Math.max(1, width), "") : "";
}

function persistedWorkingTimerSnapshot(data: unknown): WorkingTimerSnapshot | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	const cumulativeMs =
		typeof record.cumulativeMs === "number" && Number.isFinite(record.cumulativeMs) ? record.cumulativeMs : 0;
	const persistedAtMs =
		typeof record.persistedAtMs === "number" && Number.isFinite(record.persistedAtMs) ? record.persistedAtMs : 0;
	const startedAtMs =
		typeof record.startedAtMs === "number" && Number.isFinite(record.startedAtMs) ? record.startedAtMs : undefined;
	const lastTurnMs =
		typeof record.lastTurnMs === "number" && Number.isFinite(record.lastTurnMs) ? record.lastTurnMs : undefined;
	return {
		active: record.active === true,
		startedAtMs,
		lastTurnMs,
		cumulativeMs: Math.max(0, cumulativeMs),
		persistedAtMs: Math.max(0, persistedAtMs),
	};
}

function latestWorkingTimerSnapshot(entries: readonly unknown[]): WorkingTimerSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "custom" || record.customType !== WORKING_TIMER_ENTRY_TYPE) continue;
		const snapshot = persistedWorkingTimerSnapshot(record.data);
		if (snapshot) return snapshot;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const state: FooterRenderState = emptyFooterState();
	const usageCache = new Map<string, UsageSnapshot>();

	let currentConfig: PolishedTuiConfig = loadConfig();
	let requestFooterRender: (() => void) | undefined;
	let footerAnimationTarget: AnimationRenderTarget | undefined;
	let projectRefreshInFlight = false;
	let projectRefreshPending = false;

	let activeProvider: string | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let usageBarCache: UsageBarCache | null = null;
	let usageBarPendingKey: string | null = null;
	let usageBarsVisible = currentConfig.usageBars.visible;
	let workingAnimationTimer: AnimationMount | undefined;
	let disposed = false;
	let uiGeneration = 0;
	let activeSessionFile: string | undefined;
	let editorSessionIdentity: EditorSessionIdentity | undefined;
	let activeCtx: ExtensionContext | undefined;
	let releaseTranscriptSpacingPatch: (() => void) | undefined;

	let footerDataProvider: FooterDataProvider | undefined;
	const isStaleCtxError = (error: unknown) =>
		(error instanceof Error ? error.message : String(error)).includes("ctx is stale");
	const isCurrent = (generation: number) => !disposed && generation === uiGeneration;
	const sessionFileFor = (ctx: ExtensionContext): string | undefined => {
		try {
			return (ctx as Partial<ExtensionContext>).sessionManager?.getSessionFile?.();
		} catch (error) {
			if (isStaleCtxError(error)) return undefined;
			throw error;
		}
	};
	const isSubagentSessionFile = (sessionFile: string): boolean =>
		sessionFile.replaceAll("\\", "/").includes("/sessions/subagents/");
	const isCurrentSessionContext = (ctx: ExtensionContext): boolean => {
		const sessionFile = sessionFileFor(ctx);
		return sessionFile !== undefined && sessionFile === activeSessionFile;
	};
	const hasSessionManager = (ctx: unknown): boolean =>
		Boolean((ctx as Partial<ExtensionContext> | undefined)?.sessionManager);

	const refresh = () => {
		if (!disposed) requestFooterRender?.();
	};

	const persistWorkingTimer = (options: { freezeActive?: boolean } = {}) => {
		try {
			const snapshot = getWorkingTimerSnapshot(Date.now(), options);
			if (!snapshot.active && snapshot.lastTurnMs === undefined && snapshot.cumulativeMs === 0) return;
			pi.appendEntry(WORKING_TIMER_ENTRY_TYPE, snapshot);
		} catch {}
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

	const renderEditorTopChrome = (
		width: number,
		theme: Parameters<typeof renderEditorContextStatus>[1],
		cwd: string,
	) => {
		const safeWidth = width;
		if (safeWidth <= 0) return "";
		let usageLine = "";
		if (usageBarsVisible) {
			const usageWidth = Math.max(20, Math.min(56, Math.floor(safeWidth * 0.36)));
			ensureUsageBarLines(usageWidth);
			usageLine = truncateUsageLine(state.usageLines?.[0] ?? "", usageWidth);
		}

		const gapWidth = usageLine ? 2 : 0;
		let statusWidth = safeWidth - visibleWidth(usageLine) - gapWidth;
		if (statusWidth < 24) {
			usageLine = "";
			statusWidth = safeWidth;
		}
		state.thinkingLevel = activeCtx?.model?.reasoning ? pi.getThinkingLevel() : undefined;
		state.modelStatusBadges = readModelStatusBadges(footerDataProvider);
		setWorkingFastMode(footerDataProvider?.getExtensionStatuses().get("openai-fast:request") === "fast");
		const topStatus = renderEditorTopStatus(state, currentConfig, cwd, theme, statusWidth);
		if (!topStatus) return "";
		return [usageLine, topStatus].filter(Boolean).join("  ");
	};

	const renderEditorBottomStatus = (width: number, theme: Parameters<typeof renderEditorContextStatus>[1]) => {
		const safeWidth = Math.max(1, width);
		const contextWidth = Math.min(Math.floor(safeWidth * 0.5), safeWidth);
		const parts: string[] = [];
		if (contextWidth >= 12) parts.push(renderEditorContextStatus(state, theme, contextWidth));
		return parts.join("  ");
	};

	const sessionName = (ctx: ExtensionContext): string | undefined => {
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			getSessionName?: () => string | null | undefined;
		};
		return sessionManager.getSessionName?.() ?? undefined;
	};

	const sessionLeafId = (ctx: ExtensionContext): string | undefined => {
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			getLeafId?: () => string | null | undefined;
		};
		return sessionManager.getLeafId?.() ?? undefined;
	};

	const systemPromptText = (prompt: unknown): string => {
		if (typeof prompt === "string") return prompt;
		if (Array.isArray(prompt)) {
			return prompt
				.map((part) => {
					if (typeof part === "string") return part;
					if (part && typeof part === "object" && "text" in part) {
						const text = (part as { text?: unknown }).text;
						return typeof text === "string" ? text : "";
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}
		if (prompt && typeof prompt === "object" && "content" in prompt) {
			return systemPromptText((prompt as { content?: unknown }).content);
		}
		return String(prompt ?? "");
	};

	const syncState = (ctx: ExtensionContext, activeMessage?: unknown) => {
		const name = cleanIdentityPart(sessionName(ctx));
		editorSessionIdentity = name ? { name } : undefined;

		const totals = getUsageTotals(ctx);
		const usage = ctx.getContextUsage();
		const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow ?? 0;
		const measuredContextTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
		const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), sessionLeafId(ctx)).messages;
		const rawContextSegments = estimateContextSegments(
			activeMessage ? [...contextMessages, activeMessage] : contextMessages,
			systemPromptText(ctx.getSystemPrompt()),
		);
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

		state.modelLabel = ctx.model?.name ?? "no-model";
		state.providerLabel = formatProviderLabel(ctx.model?.provider);
		state.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
		state.modelStatusBadges = readModelStatusBadges(footerDataProvider);
		state.contextPercent = usage?.percent ?? (contextWindow > 0 ? (contextUsed / contextWindow) * 100 : null);
		state.contextTotal = contextWindow;
		state.contextUsed = contextUsed;
		state.contextSegments = scaleContextSegmentsToUsage(rawContextSegments, contextUsed);
		state.contextUsageEstimated = measuredContextTokens === undefined;
		state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
		state.costLabel = `$${totals.cost.toFixed(2)}`;
		state.hasTokens = totals.input > 0 || totals.output > 0;
		state.hasCost = totals.cost > 0;
	};

	const syncStateIfCurrent = (ctx: ExtensionContext, activeMessage?: unknown) => {
		if (disposed) return false;
		if (!isCurrentSessionContext(ctx)) return false;
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

	const stopWorkingAnimation = () => {
		workingAnimationTimer?.dispose();
		workingAnimationTimer = undefined;
	};

	const startWorkingAnimation = (ctx: ExtensionContext) => {
		setWorkingTimerStarted();
		stopWorkingAnimation();
		if (!footerAnimationTarget) return;
		workingAnimationTimer = sharedAnimationRenderScheduler.mount(
			footerAnimationTarget,
			WORKING_ANIMATION_INTERVAL_MS,
			() => {
				try {
					if (disposed || !isCurrentSessionContext(ctx) || ctx.isIdle()) {
						setWorkingTimerStopped();
						persistWorkingTimer();
						stopWorkingAnimation();
						return;
					}
				} catch (error) {
					if (isStaleCtxError(error)) {
						stopWorkingAnimation();
						return;
					}
					throw error;
				}
				advanceWorkingAnimationFrame();
			},
		);
		refresh();
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
		syncStateIfCurrent(ctx);

		const footerFactory: FooterFactory = (tui, _theme, footerData) => {
			footerDataProvider = footerData;
			requestFooterRender = () => tui.requestRender();
			footerAnimationTarget = tui;
			const disposeFocusCursor = installFocusCursor(pi, ctx, tui);
			const unsubscribeBranch = footerData.onBranchChange(() => {
				syncStateIfCurrent(ctx);
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
					footerAnimationTarget = undefined;
					footerDataProvider = undefined;
					stopRefreshTimer();
				},
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		};
		polishedTui.bind(ctx).footer.replace(footerFactory);
	};

	const installEditor = (ctx: ExtensionContext) => {
		syncStateIfCurrent(ctx);
		const cwd = ctx.cwd;
		setEditorSessionIdentityProvider(() => editorSessionIdentity);
		setEditorChromeProvider((width, theme, options) => {
			const bottomWidth = Math.max(1, width - options.modeReserve);
			return {
				topRight: renderEditorTopChrome(options.topRightWidth, theme, cwd),
				bottomRight: renderEditorBottomStatus(bottomWidth, theme),
			};
		});
		installEditorComposition(ctx.ui.theme);
	};

	const installUi = (ctx: ExtensionContext) => {
		ensureConfigExists();
		currentConfig = loadConfig();
		usageBarsVisible = currentConfig.usageBars.visible;
		const persistedWorkingTimer = latestWorkingTimerSnapshot(ctx.sessionManager.getEntries());
		restoreWorkingTimerSnapshot(persistedWorkingTimer, {
			restoreActive: persistedWorkingTimer?.active && !ctx.isIdle(),
		});
		ctx.ui.setWorkingVisible?.(false);
		installFooter(ctx);
		installEditor(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	};

	pi.registerCommand("usage-bars", {
		description: "Show or hide provider usage bars in the editor status row",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "toggle"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (!mode) {
				ctx.ui.notify(`usage-bars ${usageBarsVisible ? "on" : "off"}`, "info");
				return;
			}
			if (mode !== "on" && mode !== "off" && mode !== "toggle") {
				ctx.ui.notify("Usage: /usage-bars [on|off]", "error");
				return;
			}
			usageBarsVisible = mode === "toggle" ? !usageBarsVisible : mode === "on";
			currentConfig = {
				...currentConfig,
				usageBars: {
					...currentConfig.usageBars,
					visible: usageBarsVisible,
				},
			};
			try {
				saveConfig(currentConfig);
			} catch {
				ctx.ui.notify("Failed to save usage-bars setting", "error");
				return;
			}
			if (usageBarsVisible && ctx.model?.provider) fetchUsage(ctx.model.provider);
			ctx.ui.notify(`usage-bars ${usageBarsVisible ? "on" : "off"}`, "info");
			refresh();
		},
	});

	pi.events.on(SUBAGENT_USAGE_EVENT, (payload: unknown) => {
		const event = payload as Partial<SubagentUsageEvent> | undefined;
		if (!activeCtx || event?.sessionFile !== activeSessionFile) return;
		if (syncStateIfCurrent(activeCtx)) refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = sessionFileFor(ctx);
		if (!sessionFile || isSubagentSessionFile(sessionFile)) return;
		activeSessionFile = sessionFile;
		activeCtx = ctx;
		disposed = false;
		uiGeneration++;
		releaseTranscriptSpacingPatch ??= await installTranscriptSpacingPatch();
		installUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (hasSessionManager(ctx) && !isCurrentSessionContext(ctx)) return;
		persistWorkingTimer({ freezeActive: true });
		disposed = true;
		uiGeneration++;
		activeSessionFile = undefined;
		activeCtx = undefined;
		requestFooterRender = undefined;
		footerAnimationTarget = undefined;
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
		editorSessionIdentity = undefined;
		resetWorkingTimerState();
		stopRefreshTimer();
		stopWorkingAnimation();
		releaseTranscriptSpacingPatch?.();
		releaseTranscriptSpacingPatch = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		startWorkingAnimation(ctx);
		persistWorkingTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		setWorkingTimerStopped();
		persistWorkingTimer();
		stopWorkingAnimation();
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

	pi.on("message_end", async (_event, ctx) => {
		if (!syncStateIfCurrent(ctx)) return;
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!isCurrentSessionContext(ctx)) return;
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
