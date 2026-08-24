import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodexNativeLifecycle } from "../src/extension.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function lifecycleHarness(options: { notifyThrows?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const calls: string[] = [];
	const notifications: string[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	};
	const runtime = {
		startSession() {
			calls.push("provider:start");
		},
		selectModel() {
			calls.push("provider:model");
		},
		shutdownSession() {
			calls.push("provider:shutdown");
		},
	};
	const diagnostics = {
		async configure() {
			calls.push("diagnostics:configure");
			throw new Error("configuration failed");
		},
		async shutdown() {
			calls.push("diagnostics:shutdown");
			throw new Error("shutdown failed");
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			notify(message: string) {
				if (options.notifyThrows) throw new Error("notification failed");
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	registerCodexNativeLifecycle(pi as never, runtime as never, diagnostics);
	return { handlers, calls, notifications, ctx };
}

test("diagnostics failures never reject provider lifecycle", async () => {
	const harness = lifecycleHarness();
	await expect(harness.handlers.get("session_start")?.({}, harness.ctx)).resolves.toBeUndefined();
	await expect(harness.handlers.get("model_select")?.({}, harness.ctx)).resolves.toBeUndefined();
	await expect(harness.handlers.get("session_shutdown")?.({}, harness.ctx)).resolves.toBeUndefined();
	expect(harness.calls).toEqual([
		"provider:start",
		"diagnostics:configure",
		"provider:model",
		"diagnostics:configure",
		"diagnostics:shutdown",
		"provider:shutdown",
	]);
	expect(harness.notifications).toEqual([
		"Codex cache diagnostics could not start: configuration failed",
		"Codex cache diagnostics could not reconfigure: configuration failed",
		"Codex cache diagnostics could not stop: shutdown failed",
	]);
});

test("notification failures never reject provider lifecycle", async () => {
	const harness = lifecycleHarness({ notifyThrows: true });
	await expect(harness.handlers.get("session_start")?.({}, harness.ctx)).resolves.toBeUndefined();
	await expect(harness.handlers.get("model_select")?.({}, harness.ctx)).resolves.toBeUndefined();
	await expect(harness.handlers.get("session_shutdown")?.({}, harness.ctx)).resolves.toBeUndefined();
	expect(harness.calls).toContain("provider:start");
	expect(harness.calls).toContain("provider:model");
	expect(harness.calls).toContain("provider:shutdown");
});

test("published settings reconfigure diagnostics in the active session", async () => {
	const handlers = new Map<string, Handler>();
	let configurations = 0;
	const lifecycle = registerCodexNativeLifecycle(
		{
			on: (name: string, handler: Handler) => {
				handlers.set(name, handler);
			},
		} as never,
		{ startSession() {}, selectModel() {}, shutdownSession() {} } as never,
		{
			async configure() {
				configurations += 1;
			},
			async shutdown() {},
		},
	);
	const ctx = { hasUI: false } as unknown as ExtensionContext;

	await lifecycle.settingsChanged();
	await handlers.get("session_start")?.({}, ctx);
	await lifecycle.settingsChanged();
	await handlers.get("session_shutdown")?.({}, ctx);
	await lifecycle.settingsChanged();

	expect(configurations).toBe(2);
});
