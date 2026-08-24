import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "pi-libactions/sdk";
import {
	DEFAULT_CODEX_NATIVE_SETTINGS,
	type CodexNativeSettings,
	getCodexNativeSettings,
} from "./contributions/xsettings.ts";

const FAST_SERVICE_TIER = "priority";
const FAST_ORIGINATOR = "codex_cli_rs";
const ROUTING_HINT = "x-codex-routing-hint";

type State = { enabled: boolean };
type ModelServiceTier = "standard" | "priority";
type ModelWithServiceTier = NonNullable<ExtensionContext["model"]> & { serviceTier?: ModelServiceTier };
// type-boundary: Pi exposes provider payloads without a type; isRecord narrows the payload before mutation.
type UntrustedProviderValue = unknown;
type Payload = Record<string, UntrustedProviderValue>;

function isRecord(value: UntrustedProviderValue): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eligible(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

function fastModeEnabled(ctx: ExtensionContext, state: State): boolean {
	const serviceTier = (ctx.model as ModelWithServiceTier | undefined)?.serviceTier;
	return state.enabled || serviceTier === "priority";
}

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("codex-native-fast", enabled && eligible(ctx) ? "fast" : undefined);
}

export default function registerFastMode(
	pi: ExtensionAPI,
	getSettings: () => CodexNativeSettings = getCodexNativeSettings,
): {
	settingsChanged(settings: Readonly<CodexNativeSettings>): void;
	dispose(): void;
} {
	const states = new WeakMap<object, State>();
	let currentContext: ExtensionContext | undefined;
	let defaultEnabled = DEFAULT_CODEX_NATIVE_SETTINGS.fastModeDefault;

	function stateFor(ctx: ExtensionContext): State {
		const key = ctx.sessionManager as object;
		let state = states.get(key);
		if (!state) {
			state = { enabled: defaultEnabled };
			states.set(key, state);
		}
		return state;
	}

	function toggle(ctx: ExtensionContext): void {
		const state = stateFor(ctx);
		state.enabled = !state.enabled;
		const enabled = fastModeEnabled(ctx, state);
		updateStatus(ctx, enabled);
		ctx.ui.notify(
			state.enabled
				? "Fast mode enabled"
				: enabled
					? "Fast mode remains enabled by the active role"
					: "Fast mode disabled",
			"info",
		);
	}

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		defaultEnabled = getSettings().fastModeDefault;
		const state = { enabled: defaultEnabled };
		states.set(ctx.sessionManager as object, state);
		updateStatus(ctx, fastModeEnabled(ctx, state));
	});
	pi.on("model_select", (_event, ctx) => {
		const state = stateFor(ctx);
		updateStatus(ctx, fastModeEnabled(ctx, state));
	});
	pi.on("before_provider_request", (event, ctx) => {
		const state = stateFor(ctx);
		const enabled = fastModeEnabled(ctx, state);
		updateStatus(ctx, enabled);
		if (!enabled || !eligible(ctx) || !isRecord(event.payload)) return undefined;
		return { ...event.payload, service_tier: FAST_SERVICE_TIER };
	});
	pi.on("before_provider_headers", (event, ctx) => {
		if (!eligible(ctx) || !ctx.model) return;
		const state = stateFor(ctx);
		if (!fastModeEnabled(ctx, state)) {
			event.headers[ROUTING_HINT] = null;
			return;
		}
		event.headers.originator = FAST_ORIGINATOR;
		event.headers[ROUTING_HINT] = `model=${ctx.model.id};tier=${FAST_SERVICE_TIER}`;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (currentContext?.sessionManager === ctx.sessionManager) currentContext = undefined;
		states.delete(ctx.sessionManager as object);
	});
	const unregisterAction = registerAction({
		id: "codex.fast.toggle",
		description: "Toggle OpenAI Codex Fast mode",
		run: toggle,
	});
	return {
		settingsChanged(settings) {
			const changed = settings.fastModeDefault !== defaultEnabled;
			defaultEnabled = settings.fastModeDefault;
			if (!changed || !currentContext) return;
			const state = stateFor(currentContext);
			state.enabled = defaultEnabled;
			updateStatus(currentContext, fastModeEnabled(currentContext, state));
		},
		dispose: unregisterAction,
	};
}
