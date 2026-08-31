import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureSidePanelRegistry, registerSidePanelProvider, type SidePanelProvider } from "pi-libtui";
import execCommandExtension from "../src/extension.ts";

type LifecycleHandler = (event: { reason?: string }, context: ExtensionContext) => void | Promise<void>;

// type-boundary: The focused extension harness implements only the ExtensionAPI methods used during registration.
type ExtensionApiBoundary = unknown;

// type-boundary: The child context supplies only the lifecycle fields exercised by session_start and session_shutdown.
type ExtensionContextBoundary = unknown;

test("a non-UI child session does not replace the parent Process Hub side-panel provider", async () => {
	const parentProvider: SidePanelProvider = {
		id: "pi-exec-command.process-hub",
		session: {},
		attach: () => undefined,
	};
	const registry = ensureSidePanelRegistry(globalThis);
	const removeParentProvider = registerSidePanelProvider(parentProvider, globalThis);
	const handlers = new Map<string, LifecycleHandler>();
	const piBoundary: ExtensionApiBoundary = {
		registerCommand() {},
		registerTool() {},
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, handler);
		},
	};
	const pi = piBoundary as ExtensionAPI;
	const contextBoundary: ExtensionContextBoundary = {
		mode: "print",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "child-process-hub",
		},
	};
	const context = contextBoundary as ExtensionContext;

	await execCommandExtension(pi);
	try {
		await handlers.get("session_start")?.({ reason: "startup" }, context);
		expect(registry.providers().find(({ id }) => id === parentProvider.id)).toBe(parentProvider);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, context);
		expect(registry.providers().find(({ id }) => id === parentProvider.id)).toBe(parentProvider);
	} finally {
		removeParentProvider();
	}
});
