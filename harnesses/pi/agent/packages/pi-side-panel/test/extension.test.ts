import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureSidePanelRegistry } from "pi-libtui";
import sidePanelExtension from "../src/extension.ts";

type EventHandler = (event: object, context: ExtensionContext) => void | Promise<void>;

// type-boundary: The focused extension harness implements only the ExtensionAPI methods exercised by sidePanelExtension.
type ExtensionApiBoundary = unknown;

// type-boundary: The child context only needs lifecycle identity and mode/UI capability for this regression.
type ExtensionContextBoundary = unknown;

test("does not replace the parent side-panel host for a non-UI child session", async () => {
	const registry = ensureSidePanelRegistry(globalThis);
	const resetHost = registry.installHost();
	resetHost.dispose();
	const parentHost = registry.installHost();
	const events = new Map<string, EventHandler>();
	const piHarness = {
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
		registerCommand(_name: string, _command: { handler: (args: string, context: ExtensionCommandContext) => void }) {},
	};

	const boundary: ExtensionApiBoundary = piHarness;
	sidePanelExtension(boundary as ExtensionAPI);
	const contextBoundary: ExtensionContextBoundary = {
		mode: "print",
		hasUI: false,
		sessionManager: {},
	};
	const context = contextBoundary as ExtensionContext;

	await events.get("session_start")?.({}, context);
	await events.get("session_shutdown")?.({ reason: "quit" }, context);

	expect(registry.hasHost()).toBe(true);
	parentHost.dispose();
});
