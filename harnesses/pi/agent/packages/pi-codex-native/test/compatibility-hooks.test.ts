import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexCompatibleProvider } from "../src/compatibility.ts";
import registerContextWindow from "../src/context-window.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";
import registerFastMode from "../src/fast-mode.ts";
import { registerTextVerbosity } from "../src/provider/text-verbosity.ts";

const model = { provider: "litellm", api: "openai-completions", id: "gpt-5.6-luna", contextWindow: 100 } as never;

test("registered LiteLLM route receives fast and Chat Completions verbosity hooks", () => {
	const unregister = registerCodexCompatibleProvider({
		provider: "litellm",
		model: "gpt-5.6-luna",
		api: "openai-completions",
		fastMode: true,
	});
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
	};
	const ctx = {
		model,
		sessionManager: {},
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	registerFastMode(pi as never, () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS, fastModeDefault: true }));
	registerTextVerbosity(pi as never, () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS, textVerbosity: "high" }));
	for (const handler of handlers.get("session_start") ?? []) handler({} as never, ctx);
	const requests = handlers.get("before_provider_request")!.map((handler) => handler({ payload: {} } as never, ctx));
	expect(requests).toContainEqual({ service_tier: "priority" });
	expect(requests).toContainEqual({ verbosity: "high" });
	const headers = { originator: "stale", "x-codex-routing-hint": "stale" } as Record<string, string | null>;
	for (const handler of handlers.get("before_provider_headers") ?? []) handler({ headers } as never, ctx);
	expect(headers).toMatchObject({
		originator: "codex_cli_rs",
		"x-codex-routing-hint": "model=gpt-5.6-luna;tier=priority",
	});
	unregister();
});

test("fast-mode cleanup clears harness headers when the route is no longer eligible", () => {
	const unregister = registerCodexCompatibleProvider({
		provider: "litellm",
		model: "gpt-5.6-luna",
		api: "openai-completions",
		fastMode: true,
	});
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand() {},
	};
	const ctx = {
		model: { provider: "litellm", api: "openai-completions", id: "claude-opus-5", contextWindow: 100 },
		sessionManager: {},
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	registerFastMode(pi as never, () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS, fastModeDefault: true }));
	for (const handler of handlers.get("session_start") ?? []) handler({} as never, ctx);
	const headers = { originator: "stale", "x-codex-routing-hint": "stale" } as Record<string, string | null>;
	for (const handler of handlers.get("before_provider_headers") ?? []) handler({ headers } as never, ctx);
	expect(headers.originator).toBe("stale");
	expect(headers["x-codex-routing-hint"]).toBe("stale");
	unregister();
});

test("registered LiteLLM route applies local context metadata", async () => {
	const unregister = registerCodexCompatibleProvider({
		provider: "litellm",
		model: "gpt-5.6-luna",
		api: "openai-completions",
	});
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	let selected: unknown;
	const pi = {
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		setModel: async (next: unknown) => {
			selected = next;
		},
		registerCommand() {},
	};
	const ctx = {
		model,
		sessionManager: {},
		hasUI: true,
		ui: { setStatus() {}, notify() {}, theme: {} },
	} as unknown as ExtensionContext;
	registerContextWindow(pi as never, () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS }));
	await handlers.get("session_start")?.({} as never, ctx);
	expect((selected as { contextWindow: number }).contextWindow).toBeGreaterThan(100);
	unregister();
});
