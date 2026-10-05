import { afterEach, expect, spyOn, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	getMarkdownTheme,
	initTheme,
	type MarkdownTransformer,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	ProcessTerminal,
	setCapabilities,
	stripTerminalSequences,
	TuiAltScreen,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { configureTuiAppearance, getTuiAppearance } from "@luan.sh/pi-libtui";
import { ensureMouseRegistry, type OverlayMouseRegion } from "@luan.sh/pi-libtui/mouse";
import { webCitationTargets } from "../src/ui/web-citation-preview.ts";
import { registerWebCitations } from "../src/ui/web-citations.ts";

type CitationEvent = Extract<
	ExtensionEvent,
	{
		type: "session_start" | "session_tree" | "session_shutdown" | "tool_result";
	}
>;
type Handler = (event: CitationEvent, context: ExtensionContext) => void;
// type-boundary: The registration harness supplies only the public APIs used by registerWebCitations.
type HarnessBoundary = unknown;

const citation = (...ids: string[]) => `\uE200cite\uE202${ids.join("\uE202")}\uE201`;
const source = (id: string, url: string, title = "Page title", excerpt = "") =>
	`${title} (${url})\n${citation(id)} [wordlim: 200]\n${excerpt}`;
const renderContext = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };
const capabilities = getCapabilities();
const appearance = getTuiAppearance();
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	setCapabilities(capabilities);
	configureTuiAppearance(appearance);
});
const plain = (text: string) => stripTerminalSequences(text).replaceAll("\u00a0", " ");
const themeBoundary: HarnessBoundary = {
	name: "citation-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;220;220;220m",
	getBgAnsi: () => "\x1b[48;2;30;34;42m",
};
const theme = themeBoundary as Theme;

function testTui(): TUI {
	const terminal = new ProcessTerminal();
	terminal.write = () => {};
	return new TuiAltScreen(terminal);
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "fixture",
		content: [{ type: "text", text }],
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function harness(tui = testTui()) {
	const handlers = new Map<string, Handler>();
	let transform: MarkdownTransformer | undefined;
	const apiBoundary: HarnessBoundary = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerMarkdownTransformer(handler: MarkdownTransformer) {
			transform = handler;
		},
	};
	registerWebCitations(apiBoundary as Pick<ExtensionAPI, "on" | "registerMarkdownTransformer">);
	const sessionManager = SessionManager.inMemory("/tmp/citation-test");
	let widget: (Component & { dispose?(): void }) | undefined;
	const contextBoundary: HarnessBoundary = {
		sessionManager,
		mode: "tui",
		ui: {
			theme,
			setWidget(_key: string, factory?: (tui: TUI, theme: Theme) => Component & { dispose?(): void }) {
				widget?.dispose?.();
				widget = factory && tui ? factory(tui, theme) : undefined;
			},
		},
	};
	const emit = (event: CitationEvent) => handlers.get(event.type)?.(event, contextBoundary as ExtensionContext);
	emit({ type: "session_start", reason: "startup" });
	cleanups.push(() => emit({ type: "session_shutdown", reason: "quit" }));
	return {
		sessionManager,
		emit,
		render: (text: string, isStreaming = false) => transform!(text, { ...renderContext, isStreaming }),
		transform: () => transform!,
		decorate: (screen: string[], width = 80, height = 30) =>
			ensureMouseRegistry().dispatchScreenDecorators(screen, { width, height, hasOverlay: tui.hasOverlay() }),
		web(text: string, parentToolCallId?: string) {
			emit({
				type: "tool_result",
				toolName: "web__run",
				toolCallId: "web",
				input: {},
				content: [{ type: "text", text }],
				details: undefined,
				isError: false,
				parentToolCallId,
			});
		},
	};
}

test("direct and nested web sources become stable page-title pills without changing model text", () => {
	const h = harness();
	h.web(source("turn0search0", "https://example.com/one", "First page"));
	h.web(source("turn1view0", "https://example.com/two", "Second page"), "codemode");
	const text = `Claim ${citation("turn1view0", "turn0search0", "turn1view0")}. Again ${citation("turn1view0")}.`;
	const rendered = h.render(text);
	expect(plain(rendered)).toContain("First page");
	expect(plain(rendered).match(/Second page/g)).toHaveLength(2);
	expect(webCitationTargets([rendered]).map((target) => target.id)).toEqual([
		"turn1view0",
		"turn0search0",
		"turn1view0",
	]);
	expect(h.render(text)).toBe(rendered);
	expect(h.transform()(text, { ...renderContext, messageType: "user" })).toBe(text);
	expect(text).toContain("\uE200");
});

test("streaming never displays incomplete citation protocol tokens", () => {
	const h = harness();
	const token = citation("turn0search0");
	for (let length = 1; length < token.length; length++) {
		expect(h.render(`Claim ${token.slice(0, length)}`, true)).toBe("Claim ");
	}
	expect(h.render(`Claim ${token}`, true)).toBe("Claim [turn0search0]");
	expect(h.render("Claim \uE200cite\uE202", false)).toBe("Claim [source unavailable]");
});

test("reload restores source URLs from direct and persisted nested results; branches do not leak links", () => {
	const h = harness();
	const root = h.sessionManager.appendMessage({ role: "user", content: "Question", timestamp: 0 });
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "direct",
		toolName: "web__run",
		isError: false,
		timestamp: 0,
		content: [{ type: "text", text: source("turn0search0", "https://example.com/direct") }],
	});
	h.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "parent",
		toolName: "codemode",
		isError: false,
		timestamp: 0,
		content: [{ type: "text", text: "Script completed" }],
		details: {
			libtuiNestedCalls: {
				version: 1,
				calls: [
					null,
					{
						name: "web__run",
						result: {
							content: [{ type: "text", text: source("turn1view0", "https://example.com/nested") }],
						},
					},
				],
			},
		},
	});
	h.emit({ type: "session_start", reason: "reload" });
	const restored = h.render(citation("turn0search0", "turn1view0"));
	expect(webCitationTargets([restored]).map((target) => target.id)).toEqual(["turn0search0", "turn1view0"]);
	const linked = h.decorate([restored]).join("\n");
	expect(linked).toContain("\x1b]8;;https://example.com/direct\x1b\\");
	expect(linked).toContain("\x1b]8;;https://example.com/nested\x1b\\");
	h.sessionManager.branch(root);
	h.emit({ type: "session_tree", oldLeafId: null, newLeafId: root });
	expect(h.render(citation("turn0search0", "turn1view0"))).toBe("[turn0search0] [turn1view0]");
});

test("unsafe URLs cannot become links; URL punctuation stays inert", () => {
	const h = harness();
	for (const url of [
		"javascript:alert(1)",
		"https://example.com/\x1b]52;secret",
		"https://user:pass@example.com",
		"https://[invalid]",
	])
		h.web(source("turn0search0", url));
	expect(h.render(citation("turn0search0"))).toBe("[turn0search0]");
	h.web(source("turn1view0", "https://example.com/a_(b)"));
	expect(h.decorate([h.render(citation("turn1view0"))]).join("\n")).toContain(
		"\x1b]8;;https://example.com/a_(b)\x1b\\",
	);
});

test.each([20, 40, 80])(
	"Pi renders literal, clickable source pills at %i columns without spilling paint or markers",
	(width) => {
		initTheme();
		configureTuiAppearance({ powerline: true });
		setCapabilities({ ...capabilities, hyperlinks: true });
		const h = harness();
		h.web(source("turn0search0", "https://example.com/", "API [v2] *ok* $5"));
		const message = assistantMessage(`Claim ${citation("turn0search0")}.`);
		const component = new AssistantMessageComponent(message, true, getMarkdownTheme(), undefined, 0, [h.transform()]);
		const lines = h.decorate(component.render(width), width);
		const rendered = lines.join("\n");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(plain(rendered)).toContain(width === 20 ? "API [v2]" : "API [v2] *ok* $5");
		expect(plain(rendered)).not.toContain("[1]");
		expect(rendered).toContain("\x1b]8;;https://example.com/");
		expect(rendered).not.toMatch(/[\uE200-\uE202\u{f0000}]/u);
		expect(webCitationTargets(lines)).toHaveLength(1);
	},
);

test("wrapped CJK source labels keep hover targets on every visible fragment", () => {
	initTheme();
	const h = harness();
	h.web(source("turn0search0", "https://example.com/", "文 [v2] $5 *x* ```z```"));
	const component = new AssistantMessageComponent(
		assistantMessage(`before ${citation("turn0search0")} after`),
		true,
		getMarkdownTheme(),
		undefined,
		0,
		[h.transform()],
	);
	const lines = h.decorate(component.render(20), 20);
	const targets = webCitationTargets(lines);
	expect(targets.length).toBeGreaterThan(1);
	expect(targets.every((target) => target.id === "turn0search0" && target.rect.x + target.rect.width <= 20)).toBe(true);
	expect(lines.filter((line) => line.includes("\x1b]8;;https://example.com/"))).toHaveLength(targets.length);
});

test("source titles and URLs cannot introduce columns into Markdown tables", () => {
	initTheme();
	const h = harness();
	h.web(source("turn0search0", "https://example.com/a|b", "Docs | API"));
	const text = `| Claim | Source |\n| --- | --- |\n| Verified | ${citation("turn0search0")} |`;
	const component = new AssistantMessageComponent(assistantMessage(text), true, getMarkdownTheme(), undefined, 0, [
		h.transform(),
	]);
	const rendered = component.render(80).join("\n");
	expect(plain(rendered)).toContain("Docs · API");
	expect(plain(rendered)).toContain("Verified");
	expect(rendered).toContain("\x1b]8;;https://example.com/a%7Cb");
});

test("hover shows the full source title, URL, and excerpt and yields to selection", async () => {
	initTheme();
	const terminal = new ProcessTerminal();
	terminal.write = () => {};
	const tui = new TuiAltScreen(terminal);
	const overlaySpy = spyOn(tui, "showOverlay");
	cleanups.push(() => overlaySpy.mockRestore());
	const registry = ensureMouseRegistry();
	const regions = new Set<OverlayMouseRegion>();
	const original = registry.registerOverlayRegion.bind(registry);
	const spy = spyOn(registry, "registerOverlayRegion").mockImplementation((region) => {
		regions.add(region);
		const remove = original(region);
		return () => {
			regions.delete(region);
			remove();
		};
	});
	cleanups.push(() => spy.mockRestore());
	const h = harness(tui);
	h.web(
		source(
			"turn0search0",
			"https://delta.dev/docs",
			"Delta & Git — full title",
			"L0: Snapshots include shell edits.\nL1: Review changes by turn.",
		),
	);
	const screen = Array<string>(30).fill("");
	const component = new AssistantMessageComponent(
		assistantMessage(`Claim ${citation("turn0search0")}.`),
		true,
		getMarkdownTheme(),
		undefined,
		0,
		[h.transform()],
	);
	screen[10] = component.render(80).find((line) => line.includes("Delta"))!;
	const frame = (selectionActive = false) =>
		registry.dispatchScreenDecorators(screen, { width: 80, height: 30, hasOverlay: tui.hasOverlay(), selectionActive });
	frame();
	const region = [...regions].find((region) => region.id.startsWith("pi-codex-native.web-citations:"))!;
	expect(region).toBeDefined();
	const rect = region.getRect()!;
	region.onMouse({
		type: "enter",
		row: 0,
		col: 0,
		screenRow: rect.y,
		screenCol: rect.x,
		button: undefined,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});
	await Promise.resolve();
	expect(tui.hasOverlay()).toBe(true);
	const preview = plain(overlaySpy.mock.calls.at(-1)![0].render(60).join("\n"));
	expect(preview).toContain("Delta & Git — full title");
	expect(preview).toContain("https://delta.dev/docs");
	expect(preview).toContain("Snapshots include shell edits.");
	expect(preview).toContain("Review changes by turn.");
	expect(preview).not.toContain("[wordlim:");
	frame(true);
	expect(tui.hasOverlay()).toBe(false);
	expect([...regions].filter((region) => region.id.startsWith("pi-codex-native.web-citations:"))).toHaveLength(0);
});
