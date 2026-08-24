import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerAction } from "pi-libactions/sdk";
import { tuiTheme, type TuiForegroundColor } from "pi-libtui";
import { CONTEXT_WINDOW_PRESETS, requestedContextWindowPreset, type ContextWindowPreset } from "pi-libcontext/sdk";
import { getCodexNativeSettings, type CodexNativeSettings } from "./contributions/xsettings.ts";

const WINDOWS: Readonly<Record<ContextWindowPreset, number>> = {
	smart: 180_000,
	balanced: 272_000,
	enhanced: 400_000,
	large: 600_000,
	max: 1_000_000,
};
const COLORS = {
	smart: { hue: "green", shade: 3 },
	balanced: { hue: "cyan", shade: 3 },
	enhanced: { hue: "blue", shade: 4 },
	large: { hue: "magenta", shade: 4 },
	max: { hue: "red", shade: 5 },
} as const satisfies Readonly<Record<ContextWindowPreset, TuiForegroundColor>>;
// Pi does not expose the effective compaction threshold. Match its compiled
// default until a public API exposes the configured reserve.
const DEFAULT_COMPACTION_RESERVE = 16_384;

type State = { preset: ContextWindowPreset; upgradedPreset?: ContextWindowPreset };

function eligible(model: Model<Api> | undefined): model is Model<Api> {
	return (
		model?.provider === "openai-codex" && model.api === "openai-codex-responses" && model.id.startsWith("gpt-5.6-")
	);
}

function label(preset: ContextWindowPreset): string {
	return `${preset[0]!.toUpperCase()}${preset.slice(1)} (${WINDOWS[preset] / 1_000}k)`;
}

export default function registerContextWindow(
	pi: ExtensionAPI,
	getSettings: () => CodexNativeSettings = getCodexNativeSettings,
): { settingsChanged(settings: Readonly<CodexNativeSettings>): Promise<void>; dispose(): void } {
	const states = new WeakMap<object, State>();
	let currentContext: ExtensionContext | undefined;
	let applying = false;

	function stateFor(ctx: ExtensionContext): State {
		const key = ctx.sessionManager as object;
		let state = states.get(key);
		if (!state) {
			state = { preset: getSettings().contextWindowPreset };
			states.set(key, state);
		}
		return state;
	}

	function effectivePreset(ctx: ExtensionContext): ContextWindowPreset {
		const state = stateFor(ctx);
		const requested = requestedContextWindowPreset(ctx) ?? state.preset;
		if (!state.upgradedPreset) return requested;
		return CONTEXT_WINDOW_PRESETS.indexOf(state.upgradedPreset) > CONTEXT_WINDOW_PRESETS.indexOf(requested)
			? state.upgradedPreset
			: requested;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const preset = effectivePreset(ctx);
		const colors = tuiTheme(ctx.ui.theme);
		ctx.ui.setStatus(
			"codex-native-context",
			eligible(ctx.model) ? colors.fg(COLORS[preset], label(preset)) : undefined,
		);
	}

	async function apply(ctx: ExtensionContext): Promise<void> {
		if (applying || !eligible(ctx.model)) {
			updateStatus(ctx);
			return;
		}
		const preset = effectivePreset(ctx);
		const contextWindow = WINDOWS[preset];
		if (ctx.model.contextWindow === contextWindow) {
			updateStatus(ctx);
			return;
		}
		applying = true;
		try {
			await pi.setModel({ ...ctx.model, contextWindow });
		} finally {
			applying = false;
			updateStatus(ctx);
		}
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		const state = stateFor(ctx);
		const current = effectivePreset(ctx);
		state.preset =
			CONTEXT_WINDOW_PRESETS[(CONTEXT_WINDOW_PRESETS.indexOf(current) + 1) % CONTEXT_WINDOW_PRESETS.length]!;
		state.upgradedPreset = undefined;
		await apply(ctx);
		ctx.ui.notify(`Codex context: ${label(effectivePreset(ctx))}`, "info");
	}

	async function beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
		if (event.reason !== "threshold" || !eligible(ctx.model)) return undefined;
		const policy = getSettings().contextAutoUpgrade;
		if (policy !== "always") return undefined;
		const current = effectivePreset(ctx);
		const index = CONTEXT_WINDOW_PRESETS.indexOf(current);
		if (index < CONTEXT_WINDOW_PRESETS.length - 1) {
			stateFor(ctx).upgradedPreset = CONTEXT_WINDOW_PRESETS[index + 1]!;
			await apply(ctx);
			ctx.ui.notify(`Skipped compaction; Codex context upgraded to ${label(effectivePreset(ctx))}.`, "info");
			return { cancel: true } as const;
		}
		// At the largest supported tier, normal compaction is the only safe path.
		return undefined;
	}

	async function upgradeMidTurn(ctx: ExtensionContext): Promise<void> {
		if (getSettings().contextAutoUpgrade !== "mid-turn" || !eligible(ctx.model)) return;
		const usage = ctx.getContextUsage();
		if (usage?.tokens === null || usage?.tokens === undefined) return;
		const current = effectivePreset(ctx);
		const index = CONTEXT_WINDOW_PRESETS.indexOf(current);
		if (index >= CONTEXT_WINDOW_PRESETS.length - 1 || usage.tokens <= WINDOWS[current] - DEFAULT_COMPACTION_RESERVE)
			return;
		stateFor(ctx).upgradedPreset = CONTEXT_WINDOW_PRESETS[index + 1]!;
		await apply(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		states.set(ctx.sessionManager as object, { preset: getSettings().contextWindowPreset });
		await apply(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		currentContext = ctx;
		await apply(ctx);
	});
	// Role preferences become active after their model-select event completes.
	pi.on("before_agent_start", async (_event, ctx) => apply(ctx));
	pi.on("turn_end", async (event, ctx) => {
		if (event.toolResults.length > 0) await upgradeMidTurn(ctx);
	});
	pi.on("session_before_compact", beforeCompact);
	pi.on("session_shutdown", (_event, ctx) => {
		if (currentContext?.sessionManager === ctx.sessionManager) currentContext = undefined;
		states.delete(ctx.sessionManager as object);
	});
	const unregisterAction = registerAction({
		id: "codex.context.cycle",
		description: "Cycle the GPT-5.6 Codex context window",
		run: cycle,
	});
	return {
		async settingsChanged(settings) {
			if (!currentContext) return;
			stateFor(currentContext).preset = settings.contextWindowPreset;
			stateFor(currentContext).upgradedPreset = undefined;
			await apply(currentContext);
		},
		dispose: unregisterAction,
	};
}
