import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	emitOpenAIFastRequest,
	getOpenAIFastOverride,
	type OpenAIFastOverride,
	type OpenAIFastRequestEvent,
	setOpenAIFastOverride,
} from "../shared/openai-fast-state";
import { defineExtensionTui } from "../shared/tui";

const EXTENSION_ID = "openai-fast";
const PROVIDER_ID = "openai-codex";
const API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const SUPPORTED_MODELS_LABEL = "gpt-5.4, gpt-5.5, gpt-5.6-sol, gpt-5.6-terra, or gpt-5.6-luna";
const fastTui = defineExtensionTui({ id: EXTENSION_ID });

const DEFAULT_CONFIG: OpenAIFastConfig = {
	enabled: false,
	showStatus: true,
};

type FastOverride = OpenAIFastOverride;
type OpenAIFastConfig = { enabled: boolean; showStatus: boolean };
type SessionState = {
	config: OpenAIFastConfig;
	override: FastOverride;
	lastInjectedAt?: number;
	lastInjectedModel?: string;
};
type ProjectConfigContext = { cwd: string; isProjectTrusted?: () => boolean };
type RecursivePartial<T> = { [P in keyof T]?: T[P] extends object ? RecursivePartial<T[P]> : T[P] };
type PayloadRecord = Record<string, unknown>;
type Eligibility = { eligible: boolean; modelKey: string; reason?: string };

function readConfigFile(path: string): RecursivePartial<OpenAIFastConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return isPayloadRecord(parsed) ? (parsed as RecursivePartial<OpenAIFastConfig>) : {};
	} catch (error) {
		console.error(`Warning: Could not parse ${path}: ${error}`);
		return {};
	}
}

function mergeConfig(base: OpenAIFastConfig, overrides: RecursivePartial<OpenAIFastConfig>): OpenAIFastConfig {
	return {
		enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : base.enabled,
		showStatus: typeof overrides.showStatus === "boolean" ? overrides.showStatus : base.showStatus,
	};
}

function findProjectConfigPath(cwd: string): string {
	let current = cwd;
	while (true) {
		const candidate = join(current, ".pi", "openai-fast.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(cwd, ".pi", "openai-fast.json");
		current = parent;
	}
}

function loadConfig(ctx: ProjectConfigContext): OpenAIFastConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "openai-fast.json"));
	const projectConfig = ctx.isProjectTrusted?.() ? readConfigFile(findProjectConfigPath(ctx.cwd)) : {};
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function modelKey(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
}

function isFastEnabled(state: SessionState): boolean {
	if (state.override === "on") return true;
	if (state.override === "off") return false;
	return state.config.enabled;
}

function describeMode(state: SessionState): string {
	if (state.override === "on") return "on (runtime override)";
	if (state.override === "off") return "off (runtime override)";
	return state.config.enabled ? "on (config default)" : "off (config default)";
}

function getEligibility(ctx: ExtensionContext): Eligibility {
	const model = ctx.model;
	if (!model) return { eligible: false, modelKey: "no-model", reason: "no model is selected" };
	const key = `${model.provider}/${model.id}`;
	if (model.provider !== PROVIDER_ID) {
		return { eligible: false, modelKey: key, reason: `current provider is ${model.provider}, not ${PROVIDER_ID}` };
	}
	if (model.api !== API_ID) {
		return { eligible: false, modelKey: key, reason: `current API is ${model.api}, not ${API_ID}` };
	}
	if (!SUPPORTED_MODELS.has(model.id)) {
		return { eligible: false, modelKey: key, reason: `Fast mode is only enabled for ${SUPPORTED_MODELS_LABEL}` };
	}
	if (!ctx.modelRegistry.isUsingOAuth(model)) {
		return {
			eligible: false,
			modelKey: key,
			reason: "ChatGPT OAuth auth is required; API-key auth is intentionally not used",
		};
	}
	return { eligible: true, modelKey: key };
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;
	const status = fastTui.bind(ctx).status;
	if (state.config.showStatus && isFastEnabled(state) && getEligibility(ctx).eligible) status.set("active", "fast");
	else status.clear("active");
}

function updateRequestStatus(ctx: ExtensionContext, active: boolean): void {
	const event: OpenAIFastRequestEvent = {
		active,
		sessionFile: ctx.sessionManager.getSessionFile?.() ?? undefined,
	};
	emitOpenAIFastRequest(event);
	if (!ctx.hasUI) return;
	const status = fastTui.bind(ctx).status;
	if (active) status.set("request", "fast");
	else status.clear("request");
}

function getStatusMessage(ctx: ExtensionContext, state: SessionState): string {
	const enabled = isFastEnabled(state);
	const eligibility = getEligibility(ctx);
	const injected = state.lastInjectedAt
		? ` Last injected for ${state.lastInjectedModel ?? "unknown model"} ${Math.max(0, Math.round((Date.now() - state.lastInjectedAt) / 1000))}s ago.`
		: "";
	if (enabled && eligibility.eligible) {
		return `OpenAI Fast mode is ${describeMode(state)} and active for ${eligibility.modelKey}; requests will use service_tier=${FAST_SERVICE_TIER}.${injected}`;
	}
	if (enabled) {
		return `OpenAI Fast mode is ${describeMode(state)}, but inactive for ${eligibility.modelKey}: ${eligibility.reason}.${injected}`;
	}
	return `OpenAI Fast mode is ${describeMode(state)}. Current model: ${eligibility.modelKey}.${injected}`;
}

function injectFastServiceTier(
	payload: unknown,
	ctx: ExtensionContext,
	state: SessionState,
): PayloadRecord | undefined {
	if (!isFastEnabled(state) || !getEligibility(ctx).eligible || !isPayloadRecord(payload)) return undefined;
	if (payload.model !== ctx.model?.id || "service_tier" in payload) return undefined;
	state.lastInjectedAt = Date.now();
	state.lastInjectedModel = modelKey(ctx);
	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

export default function openAIFastExtension(pi: ExtensionAPI) {
	const states = new WeakMap<object, SessionState>();

	function getState(ctx: ExtensionContext): SessionState {
		let state = states.get(ctx.sessionManager);
		if (!state) {
			state = { config: loadConfig(ctx), override: getOpenAIFastOverride() };
			states.set(ctx.sessionManager, state);
		}
		return state;
	}

	function toggle(ctx: ExtensionContext): void {
		const state = getState(ctx);
		state.override = isFastEnabled(state) ? "off" : "on";
		setOpenAIFastOverride(state.override);
		updateStatus(ctx, state);
		ctx.ui.notify(getStatusMessage(ctx, state), "info");
	}

	pi.on("session_start", (_event, ctx) => {
		const state = { config: loadConfig(ctx), override: getOpenAIFastOverride() };
		states.set(ctx.sessionManager, state);
		updateStatus(ctx, state);
	});
	pi.on("model_select", (_event, ctx) => updateStatus(ctx, getState(ctx)));
	pi.on("before_provider_request", (event, ctx) => {
		const state = getState(ctx);
		const nextPayload = injectFastServiceTier(event.payload, ctx, state);
		updateRequestStatus(ctx, Boolean(nextPayload));
		updateStatus(ctx, state);
		return nextPayload;
	});
	pi.on("message_end", (_event, ctx) => updateRequestStatus(ctx, false));
	pi.on("agent_end", (_event, ctx) => updateRequestStatus(ctx, false));

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode for this Pi runtime",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /fast", "warning");
				return;
			}
			toggle(ctx);
		},
	});
	pi.registerShortcut("alt+g", {
		description: "Toggle OpenAI Codex Fast mode",
		handler: toggle,
	});
}
