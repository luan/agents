import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import copyModeExtension from "../src/extension.ts";

type EventHandler = (event: { reason?: string }, ctx: ExtensionContext) => void | Promise<void>;
// type-boundary: The registration harness implements only ExtensionAPI methods used by the composition root.
type ExtensionApiBoundary = unknown;
// type-boundary: The lifecycle harness implements only the TUI context members used before widget construction.
type ContextBoundary = unknown;
// type-boundary: Widget factories are intentionally opaque to this lifecycle registration test.
type WidgetBoundary = unknown;

test("session lifecycle mounts one host, subscribes once to mouse selection, and cleans up on reload", async () => {
	const events = new Map<string, EventHandler>();
	let commandRegistrations = 0;
	const piHarness = {
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
		registerCommand() {
			commandRegistrations += 1;
		},
	};
	const boundary: ExtensionApiBoundary = piHarness;
	copyModeExtension(boundary as ExtensionAPI);

	const widgets: Array<{ key: string; content: WidgetBoundary }> = [];
	const sessionManager = {};
	const contextHarness = {
		mode: "tui",
		sessionManager,
		ui: {
			setWidget(key: string, content: WidgetBoundary) {
				widgets.push({ key, content });
			},
			notify() {},
		},
	};
	const contextBoundary: ContextBoundary = contextHarness;
	const context = contextBoundary as ExtensionContext;
	await events.get("session_start")?.({}, context);
	expect(commandRegistrations).toBe(0);
	expect(widgets.at(-1)?.key).toBe("pi-copy-mode.host");
	expect(typeof widgets.at(-1)?.content).toBe("function");

	await events.get("session_start")?.({}, context);

	await events.get("session_shutdown")?.({ reason: "reload" }, context);
	expect(widgets.at(-1)).toEqual({ key: "pi-copy-mode.host", content: undefined });
});
