import { afterEach, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerFastMode from "../src/fast-mode.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";
import { ensureActionsRegistry } from "pi-libactions/sdk";

const REGISTRY_KEY = Symbol.for("pi-libactions/registry/v1");

type Handler = (event: { payload?: unknown }, ctx: ExtensionContext) => unknown;

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY];
});

test("Fast mode exposes a configurable action without registering a default shortcut", async () => {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	};
	const registration = registerFastMode(pi as never);
	const registry = ensureActionsRegistry();
	const notices: string[] = [];
	const statuses: unknown[] = [];
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
		sessionManager: {},
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_id: string, value: unknown) => statuses.push(value),
		},
	} as unknown as ExtensionContext;

	await handlers.get("session_start")?.({}, ctx);
	await registry.find("codex.fast.toggle")?.run(ctx);
	const request = handlers.get("before_provider_request")?.({ payload: {} }, ctx);

	expect(request).toEqual({ service_tier: "priority" });
	expect(notices).toEqual(["Fast mode enabled"]);
	expect(statuses.at(-1)).toBe("fast");
	await registry.find("codex.fast.toggle")?.run(ctx);
	expect(notices.at(-1)).toBe("Fast mode disabled");
	registration.dispose();
	expect(registry.find("codex.fast.toggle")).toBeUndefined();
});

test("Fast mode follows its standalone default and applies xsettings changes to the active session", async () => {
	const handlers = new Map<string, Handler>();
	const statuses: unknown[] = [];
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" },
		sessionManager: {},
		hasUI: true,
		ui: { notify() {}, setStatus: (_id: string, value: unknown) => statuses.push(value) },
	} as unknown as ExtensionContext;
	const registration = registerFastMode(
		{
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
			},
			registerCommand() {},
		} as never,
		() => ({
			...DEFAULT_CODEX_NATIVE_SETTINGS,
			fastModeDefault: true,
		}),
	);

	await handlers.get("session_start")?.({}, ctx);
	expect(handlers.get("before_provider_request")?.({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
	expect(statuses.at(-1)).toBe("fast");
	const registry = ensureActionsRegistry();
	await registry.find("codex.fast.toggle")?.run(ctx);
	registration.settingsChanged({
		...DEFAULT_CODEX_NATIVE_SETTINGS,
		fastModeDefault: true,
	});
	expect(handlers.get("before_provider_request")?.({ payload: {} }, ctx)).toBeUndefined();

	registration.settingsChanged({
		...DEFAULT_CODEX_NATIVE_SETTINGS,
		fastModeDefault: false,
	});
	expect(handlers.get("before_provider_request")?.({ payload: {} }, ctx)).toBeUndefined();
	expect(statuses.at(-1)).toBeUndefined();
	registration.dispose();
});

test("Fast mode applies the selected model's requested priority tier through provider hooks", async () => {
	const handlers = new Map<string, Handler>();
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", serviceTier: "priority" },
		sessionManager: {},
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	const registration = registerFastMode({
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand() {},
	} as never);
	expect(handlers.get("before_provider_request")?.({ payload: {} }, ctx)).toEqual({ service_tier: "priority" });
	const headers: Record<string, string | null> = {};
	handlers.get("before_provider_headers")?.({ headers } as never, ctx);
	expect(headers).toEqual({ originator: "codex_cli_rs", "x-codex-routing-hint": "model=gpt-5.6-sol;tier=priority" });
	registration.dispose();
});

test("Fast mode ignores a requested tier for unsupported providers", async () => {
	const handlers = new Map<string, Handler>();
	const ctx = {
		model: { provider: "anthropic", api: "anthropic-messages", id: "claude", serviceTier: "priority" },
		sessionManager: {},
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	} as unknown as ExtensionContext;
	const registration = registerFastMode({
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand() {},
	} as never);

	expect(handlers.get("before_provider_request")?.({ payload: {} }, ctx)).toBeUndefined();
	registration.dispose();
});
