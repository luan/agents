import { afterEach, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ensureActionsRegistry } from "@luan.sh/pi-libactions/sdk";
import { ensureXSettingsRegistry } from "@luan.sh/pi-xsettings";
import registerContextWindow from "../src/context-window.ts";
import {
	CODEX_CONTEXT_COLORS,
	DEFAULT_CODEX_NATIVE_SETTINGS,
	registerCodexNativeXSettings,
} from "../src/contributions/xsettings.ts";
import { ensureContextWindowSourceRegistry } from "../src/protocol/context-window.ts";

const ACTIONS_KEY = Symbol.for("pi-libactions/registry/v1");
const SOURCES_KEY = Symbol.for("pi-codex-native/sources/v1");
const XSETTINGS_KEY = Symbol.for("pi-xsettings/registry/v1");
type TestEvent = { reason?: string; toolResults?: readonly object[] };
type Handler = (event: TestEvent, ctx: ExtensionContext) => unknown;

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[ACTIONS_KEY];
	delete (globalThis as Record<PropertyKey, unknown>)[SOURCES_KEY];
	delete (globalThis as Record<PropertyKey, unknown>)[XSETTINGS_KEY];
});

test("publishes the context preset colors to xsettings", () => {
	const unregister = registerCodexNativeXSettings();
	const definition = ensureXSettingsRegistry().registrations["pi-codex-native"]?.definitions.find(
		(candidate) => candidate.key === "contextWindowPreset",
	);
	if (definition?.type !== "enum" || "source" in definition.options) throw new Error("missing context enum");

	expect(definition.options.map(({ value, color }) => [value, color])).toEqual(Object.entries(CODEX_CONTEXT_COLORS));
	unregister();
});

function harness(policy: "never" | "mid-turn" | "always" = "never", modelId = "gpt-5.6-sol") {
	const handlers = new Map<string, Handler>();
	const windows: number[] = [];
	const statuses: Array<string | undefined> = [];
	let tokens = 0;
	const ctx = {
		model: {
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: modelId,
			contextWindow: 272_000,
		},
		sessionManager: {},
		hasUI: true,
		getContextUsage: () => ({ tokens, contextWindow: ctx.model?.contextWindow ?? 0, percent: 0 }),
		ui: {
			notify() {},
			setStatus(_id: string, value: string | undefined) {
				statuses.push(value);
			},
			theme: { fg: (color: string, text: string) => ({ color, text }) },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		async setModel(model: ExtensionContext["model"]) {
			ctx.model = model;
			windows.push(model!.contextWindow);
			return true;
		},
	} as never;
	const runtime = registerContextWindow(pi, () => ({
		...DEFAULT_CODEX_NATIVE_SETTINGS,
		contextAutoUpgrade: policy,
	}));
	return {
		ctx,
		handlers,
		runtime,
		windows,
		statuses,
		setTokens(value: number) {
			tokens = value;
		},
	};
}

test.each(["gpt-5.6-sol", "gpt-6-astra"])(
	"%s applies the balanced default and cycles session context presets",
	async (modelId) => {
		const { ctx, handlers, windows, statuses } = harness("never", modelId);
		await handlers.get("session_start")?.({}, ctx);
		await ensureActionsRegistry().find("codex.context.cycle")!.run(ctx);
		expect(windows).toEqual([400_000]);
		expect(stripTerminalSequences(statuses.at(-1) ?? "")).toBe("Enhanced (400k)");
	},
);

test.each(["gpt-5.6-sol", "gpt-6-astra"])(
	"%s applies a context preset contributed by the active model role",
	async (modelId) => {
		ensureContextWindowSourceRegistry().register({ id: "roles", preset: () => "large" });
		const { ctx, handlers, windows } = harness("never", modelId);
		await handlers.get("session_start")?.({}, ctx);
		expect(windows).toEqual([600_000]);
	},
);

test.each(["gpt-5.6-sol", "gpt-6-astra"])(
	"%s upgrades between tool turns and allows run-end compaction",
	async (modelId) => {
		const { ctx, handlers, windows, setTokens } = harness("mid-turn", modelId);
		await handlers.get("session_start")?.({}, ctx);
		setTokens(260_000);
		await handlers.get("turn_end")?.({ toolResults: [{}] }, ctx);
		expect(windows).toEqual([400_000]);
		const compact = handlers.get("session_before_compact")!;
		expect(await compact({ reason: "threshold" }, ctx)).toBeUndefined();
	},
);

test.each(["gpt-5.6-sol", "gpt-6-astra"])(
	"%s upgrades through Max then allows threshold and manual compaction",
	async (modelId) => {
		const { ctx, handlers } = harness("always", modelId);
		await handlers.get("session_start")?.({}, ctx);
		const compact = handlers.get("session_before_compact")!;
		for (let index = 0; index < 3; index++)
			expect(await compact({ reason: "threshold" }, ctx)).toEqual({ cancel: true });
		expect(await compact({ reason: "threshold" }, ctx)).toBeUndefined();
		expect(await compact({ reason: "manual" }, ctx)).toBeUndefined();
	},
);
