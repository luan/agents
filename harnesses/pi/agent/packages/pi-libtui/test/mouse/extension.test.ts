import { expect, test } from "bun:test";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { dispatchEditorRender, ensureEditorRegistry } from "../../src/editor.ts";
import mouseExtension from "../../src/extension.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
type EventHandler = (event: object, ctx: ExtensionContext) => void | Promise<void>;

// type-boundary: The focused extension harness implements only the ExtensionAPI methods exercised by mouseExtension.
type ExtensionApiBoundary = unknown;

// type-boundary: The focused context harness is narrowed to the UI methods exercised by command and lifecycle handlers.
type ExtensionContextBoundary = unknown;

// type-boundary: setWidget content is intentionally opaque to this registration test.
type WidgetContentBoundary = unknown;

// type-boundary: the focused theme harness implements only the color methods used by the paste decorator.
type ThemeBoundary = unknown;

const testTheme = {
	name: "test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
} as ThemeBoundary as Theme;

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function createPiHarness(eventBus?: object): {
	api: ExtensionAPI;
	handlers: Map<string, EventHandler[]>;
	commands: Map<string, CommandHandler>;
} {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const piHarness = {
		...(eventBus === undefined ? {} : { events: eventBus }),
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: EventHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const boundary: ExtensionApiBoundary = piHarness;
	return { api: boundary as ExtensionAPI, handlers, commands };
}

function createContext(widgets: Array<{ key: string; content: WidgetContentBoundary }>): ExtensionContext {
	const contextHarness = {
		mode: "tui" as const,
		ui: {
			theme: testTheme,
			setWorkingIndicator() {},
			setWorkingMessage() {},
			getTheme: () => testTheme,
			setTheme() {},
			setWidget(key: string, content: WidgetContentBoundary) {
				widgets.push({ key, content });
			},
			notify() {},
		},
	};
	const boundary: ExtensionContextBoundary = contextHarness;
	return boundary as ExtensionContext;
}

test("lifecycle mounts and removes the invisible bridge", async () => {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler>();
	const piHarness = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
	};
	const boundary: ExtensionApiBoundary = piHarness;
	mouseExtension(boundary as ExtensionAPI);
	expect(commands.has("libtui:colors")).toBe(true);

	const widgets: Array<{ key: string; content: WidgetContentBoundary }> = [];
	const notifications: string[] = [];
	const contextHarness = {
		mode: "tui",
		ui: {
			setWidget(key: string, content: WidgetContentBoundary) {
				widgets.push({ key, content });
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	};
	const contextBoundary: ExtensionContextBoundary = contextHarness;
	const eventContext = contextBoundary as ExtensionContext;

	await events.get("session_start")?.({}, eventContext);
	expect(widgets.at(-1)?.key).toBe("pi-libtui.mouse-bridge");
	expect(typeof widgets.at(-1)?.content).toBe("function");

	await events.get("session_shutdown")?.({}, eventContext);
	expect(widgets.at(-1)).toEqual({ key: "pi-libtui.mouse-bridge", content: undefined });
	expect(notifications).toEqual([]);
});

test("duplicate factory copies share one host lease and a later API installs independently", async () => {
	const sharedEventBus = {};
	const first = createPiHarness(sharedEventBus);
	const factories = await Promise.all(
		["one", "two", "three"].map(async (copy) => {
			const module = await import(`../../src/extension.ts?host-copy=${copy}`);
			return module.default;
		}),
	);
	for (const factory of factories) factory(first.api);

	expect(first.handlers.get("session_start")).toHaveLength(1);
	expect(first.handlers.get("session_shutdown")).toHaveLength(2);

	const widgets: Array<{ key: string; content: WidgetContentBoundary }> = [];
	const context = createContext(widgets);
	const originalRender = CustomEditor.prototype.render;
	await first.handlers.get("session_start")?.[0]?.({}, context);
	expect(widgets).toHaveLength(1);
	expect(widgets[0]?.key).toBe("pi-libtui.mouse-bridge");
	expect(CustomEditor.prototype.render).not.toBe(originalRender);

	const registry = ensureEditorRegistry();
	const rendered = dispatchEditorRender(registry, ["[paste #1 +1 lines]"], 40).join("\n");
	expect(stripAnsi(rendered)).toContain("paste #1 +1 lines");

	let replacementCalls = 0;
	const removeReplacement = registry.registerRenderDecorator({
		id: "pi-libtui.native-paste-markers",
		decorate: (lines) => {
			replacementCalls += 1;
			return [...lines, "replacement"];
		},
	});
	expect(dispatchEditorRender(registry, ["line"], 40)).toEqual(["line", "replacement"]);
	expect(replacementCalls).toBe(1);
	removeReplacement();

	for (const handler of first.handlers.get("session_shutdown") ?? []) await handler({ reason: "switch" }, context);
	expect(widgets.at(-1)).toEqual({ key: "pi-libtui.mouse-bridge", content: undefined });
	expect(CustomEditor.prototype.render).toBe(originalRender);
	const lateCopyName = "after-switch";
	const lateCopy = await import(`../../src/extension.ts?host-copy=${lateCopyName}`);
	lateCopy.default(first.api);
	expect(first.handlers.get("session_start")).toHaveLength(1);
	for (const handler of first.handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, context);

	const second = createPiHarness(sharedEventBus);
	factories[0]!(second.api);
	expect(second.handlers.get("session_start")).toHaveLength(1);
	expect(second.handlers.get("session_shutdown")).toHaveLength(2);
	const secondWidgets: Array<{ key: string; content: WidgetContentBoundary }> = [];
	const secondContext = createContext(secondWidgets);
	await second.handlers.get("session_start")?.[0]?.({}, secondContext);
	expect(secondWidgets).toHaveLength(1);
	for (const handler of second.handlers.get("session_shutdown") ?? [])
		await handler({ reason: "reload" }, secondContext);
});
