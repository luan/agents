import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { ensureActionsRegistry } from "@luan.sh/pi-libactions/sdk";
import { ensureSelectionRegistry, type SelectionActionRequest } from "@luan.sh/pi-libtui/selection";
import copyModeExtension from "../src/extension.ts";

type EventHandler = (event: { reason?: string }, ctx: ExtensionContext) => void | Promise<void>;
// type-boundary: The registration harness implements only ExtensionAPI methods used by the composition root.
type ExtensionApiBoundary = unknown;
// type-boundary: The lifecycle harness implements only the TUI context members used before widget construction.
type ContextBoundary = unknown;
// type-boundary: Widget factories are intentionally opaque to this lifecycle registration test.
type WidgetBoundary = unknown;

const shutdownReasons: SessionShutdownEvent["reason"][] = ["quit", "reload", "new", "resume", "fork"];

test.each(shutdownReasons)("session lifecycle mounts one host and cleans up on %s", async (reason) => {
	const events = new Map<string, EventHandler[]>();
	let commandRegistrations = 0;
	let transform: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0] | undefined;
	const piHarness = {
		on(name: string, handler: EventHandler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		registerMarkdownTransformer(handler: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0]) {
			transform = handler;
		},
		registerCommand() {
			commandRegistrations += 1;
		},
	};
	const boundary: ExtensionApiBoundary = piHarness;
	copyModeExtension(boundary as ExtensionAPI);

	const widgets: Array<{ key: string; content: WidgetBoundary }> = [];
	const sessionManager = { getBranch: () => [] };
	const pasted: string[] = [];
	const warnings: string[] = [];
	let dialogs = 0;
	const contextHarness = {
		mode: "tui",
		sessionManager,
		ui: {
			setWidget(key: string, content: WidgetBoundary) {
				widgets.push({ key, content });
			},
			notify(message: string) {
				warnings.push(message);
			},
			getEditorComponent: () => () => {},
			setStatus() {},
			custom: async () => {
				dialogs += 1;
				return { action: "save", text: "Highest priority first" };
			},
			pasteToEditor: (text: string) => pasted.push(text),
		},
	};
	const contextBoundary: ContextBoundary = contextHarness;
	const context = contextBoundary as ExtensionContext;
	const action = ensureActionsRegistry().find("copy-mode.enter");
	expect(action).toBeDefined();
	await action?.run(context);
	const rpcBoundary: ContextBoundary = { ...contextHarness, mode: "rpc" };
	await action?.run(rpcBoundary as ExtensionContext);
	expect(warnings).toEqual([
		"Copy mode's TUI host is not initialized. Run /reload to reattach it.",
		"Copy mode requires the interactive TUI.",
	]);
	for (const handler of events.get("session_start") ?? []) await handler({}, context);
	expect(commandRegistrations).toBe(0);
	const envelope =
		'# Response annotations:\nEach item contains text selected from an earlier response and may include a user comment.\n<response-annotations>\n[{"text":"Sort tasks","annotation":"Highest priority first"}]\n</response-annotations>\n\n## My request:\nRevise this.';
	const projected = transform?.(envelope, { messageType: "user", isStreaming: false, availableWidth: 100 });
	expect(projected).toContain("Sort tasks");
	expect(projected).toContain("Highest priority first");
	expect(projected).toContain("Revise this.");
	expect(projected).not.toContain("<response-annotations>");
	expect(widgets.at(-1)?.key).toBe("pi-copy-mode.host");
	expect(typeof widgets.at(-1)?.content).toBe("function");

	for (const handler of events.get("session_start") ?? []) await handler({}, context);

	const range = { start: { row: 0, col: 0 }, end: { row: 0, col: 9 } };
	const request: SelectionActionRequest = {
		action: "selection.comment",
		text: "Sort tasks",
		shape: "character",
		logical: range,
		screen: range,
	};
	expect(await ensureSelectionRegistry().publishSelectionAction(request)).toBe(true);
	expect(await ensureSelectionRegistry().publishSelectionAction({ ...request, action: "selection.reaction" })).toBe(
		true,
	);
	expect(dialogs).toBe(2);
	expect(pasted).toHaveLength(2);
	expect(pasted.every((token) => token.length > 0)).toBe(true);

	for (const handler of events.get("session_shutdown") ?? []) await handler({ reason }, context);
	expect(ensureActionsRegistry().find("copy-mode.enter")).toBeUndefined();
	expect(await ensureSelectionRegistry().publishSelectionAction(request)).toBe(false);
	expect(dialogs).toBe(2);
	expect(widgets.at(-1)).toEqual({ key: "pi-copy-mode.host", content: undefined });
});

test.each(shutdownReasons)("replacement claims ownership after %s; duplicate loads stay inert", async (reason) => {
	const harness = () => {
		const events = new Map<string, EventHandler[]>();
		const boundary: ExtensionApiBoundary = {
			on: (name: string, handler: EventHandler) => events.set(name, [...(events.get(name) ?? []), handler]),
			registerMarkdownTransformer() {},
		};
		copyModeExtension(boundary as ExtensionAPI);
		return events;
	};
	const owner = harness();
	const originalAction = ensureActionsRegistry().find("copy-mode.enter");
	const duplicate = harness();
	expect(owner.has("session_start")).toBe(true);
	expect(duplicate.size).toBe(0);

	const contextBoundary: ContextBoundary = { mode: "tui", ui: { setWidget() {}, notify() {}, setStatus() {} } };
	for (const handler of owner.get("session_shutdown") ?? [])
		await handler({ reason }, contextBoundary as ExtensionContext);
	expect(ensureActionsRegistry().find("copy-mode.enter")).toBeUndefined();
	const replacement = harness();
	expect(replacement.has("session_start")).toBe(true);
	expect(ensureActionsRegistry().find("copy-mode.enter")).toBeDefined();
	expect(ensureActionsRegistry().find("copy-mode.enter")).not.toBe(originalAction);
	for (const handler of replacement.get("session_shutdown") ?? [])
		await handler({ reason: "quit" }, contextBoundary as ExtensionContext);
});
