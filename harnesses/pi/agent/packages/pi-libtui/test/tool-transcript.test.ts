import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { BackgroundSurface } from "../src/background-surface.ts";
import { tuiTheme } from "../src/color/theme.ts";
import { icon } from "../src/decoration/glyphs.ts";
import { ProgressBar, progressFrame } from "../src/decoration/status.ts";
import { parseUnifiedDiff, UnifiedDiffView } from "../src/diff/index.ts";
import { ensureFoldingRegistry, foldTargetAt } from "../src/folding.ts";
import type { TuiMouseEvent } from "../src/mouse.ts";
import { SyntaxText } from "../src/syntax.ts";
import { LiveToolAction, ToolAction, type ToolActionView } from "../src/tool/action.ts";
import { ToolActivity } from "../src/tool/activity.ts";
import { settleToolCallPreview, toolCallPreview } from "../src/tool/call-preview.ts";
import { ToolDisclosureAction } from "../src/tool/disclosure-action.ts";
import { ToolTranscript } from "../src/tool/transcript.ts";
import { ToolViewRegion } from "../src/tool/view-region.ts";

const theme = {
	name: "transcript-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;140;200m"),
	getBgAnsi: () => "\x1b[48;2;30;34;40m",
} as never as Theme;

describe("progress", () => {
	test("renders deterministic bounded frames", () => {
		const colors = tuiTheme(theme);
		const frame = progressFrame(colors, { width: 20, value: 0.5 });
		expect(visibleWidth(frame)).toBe(20);
		expect(progressFrame(colors, { width: 20, value: 0.5 })).toBe(frame);
	});

	test("returns stable line arrays until invalidated", () => {
		const progress = new ProgressBar({ theme, value: 0.42, label: "Indexing", showPercentage: true });
		const first = progress.render(40);
		expect(progress.render(40)).toBe(first);
		progress.invalidate();
		expect(progress.render(40)).not.toBe(first);
	});
});

describe("tool transcript grammar", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("resolves failed and warning lifecycle markers through the active icon pack", () => {
		for (const iconPack of ["nerd-fonts", "unicode", "emoji"] as const) {
			configureTuiAppearance({ iconPack });
			expect(renderAction({ verb: "Failed", status: "failed" })).toBe(`${icon("error")} Failed`);
			expect(renderAction({ verb: "Warning", status: "warning" })).toBe(`${icon("warning")} Warning`);
		}
	});

	test("background-only surfaces preserve width and restored syntax fields never crash", () => {
		const syntax = new SyntaxText({ theme, text: undefined as never, path: ".md" });
		const surface = new BackgroundSurface({ theme, component: component("one\ntwo") });
		expect(syntax.render(40)).toEqual([""]);
		expect(surface.render(12).every((line) => visibleWidth(line) === 12)).toBe(true);
		expect(surface.render(12).join("\n")).toContain("\x1b[48;");
		expect(surface.render(12)).toBe(surface.render(12));
	});

	test("surface padding cannot inherit a child style", () => {
		const surface = new BackgroundSurface({ theme, component: component("\x1b[4munderlined") });
		const [line] = surface.render(20);
		expect(line).toMatch(/\x1b\[0m\x1b\[48;[^m]+m {10}/u);
		expect(visibleWidth(line!)).toBe(20);
	});

	test("tool surfaces start after one output row and include the action row", () => {
		const compact = new ToolActivity({
			theme,
			requestRender() {},
			view: { action: { verb: "Waited", status: "succeeded", marker: "◌" } },
		});
		const singleOutput = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action: { verb: "Edited", status: "succeeded", marker: "✎" },
				payload: { kind: "text", text: "changed", revision: 1 },
			},
		});
		const multiline = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action: { verb: "Edited", status: "succeeded", marker: "✎" },
				payload: { kind: "text", text: "first\nsecond", revision: 1 },
			},
		});
		expect(compact.render(40)[0]).not.toContain("\x1b[48;2;");
		expect(singleOutput.render(40)).toHaveLength(2);
		expect(singleOutput.render(40).every((line) => !line.includes("\x1b[48;2;"))).toBe(true);
		expect(multiline.render(40)).toHaveLength(3);
		expect(multiline.render(40).every((line) => /\x1b\[48;(?:2|5);/u.test(line))).toBe(true);
		compact.dispose();
		singleOutput.dispose();
		multiline.dispose();
	});

	test("replaces custom action rows and disposes replaced components", () => {
		let oldActionDisposals = 0;
		let oldPayloadDisposals = 0;
		let currentPayloadDisposals = 0;
		const oldPayload = disposableComponent("old payload", () => oldPayloadDisposals++);
		const currentPayload = disposableComponent("current payload", () => currentPayloadDisposals++);
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			action: disposableComponent("old action", () => oldActionDisposals++),
			view: {
				action: { verb: "ignored", status: "succeeded" },
				payload: { kind: "component", preview: oldPayload },
			},
		});
		const reused = ToolActivity.reuse(activity, {
			theme,
			requestRender() {},
			action: component("new action"),
			view: {
				action: { verb: "ignored", status: "succeeded" },
				payload: { kind: "component", preview: currentPayload },
			},
		});
		expect(reused).toBe(activity);
		expect(stripTerminalSequences(reused.render(40).join("\n"))).toContain("new action");
		expect(oldActionDisposals).toBe(1);
		expect(oldPayloadDisposals).toBe(1);
		expect(currentPayloadDisposals).toBe(0);
		reused.dispose();
		expect(currentPayloadDisposals).toBe(1);
	});

	test("recreates an activity when its structural rendering options change", () => {
		const requestRender = () => {};
		const activity = new ToolActivity({
			theme,
			requestRender,
			view: { action: { verb: "Read", status: "succeeded" } },
		});
		const surfaced = ToolActivity.reuse(activity, {
			theme,
			requestRender,
			surface: "surface.inset",
			view: {
				action: { verb: "Read", status: "succeeded" },
				payload: { kind: "text", text: "one\ntwo", revision: 1 },
			},
		});
		expect(surfaced).not.toBe(activity);
		expect(surfaced.render(40).every((line) => /\x1b\[48;(?:2|5);/u.test(line))).toBe(true);
		surfaced.dispose();
	});

	test("view regions dispose removed mode components once", () => {
		let removedDisposals = 0;
		let retainedDisposals = 0;
		const removed = disposableComponent("removed", () => removedDisposals++);
		const retained = disposableComponent("retained", () => retainedDisposals++);
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: retained },
				{ id: "full", component: removed },
			],
			requestRender() {},
		});
		region.updateModes([{ id: "preview", component: retained }]);
		expect(removedDisposals).toBe(1);
		expect(retainedDisposals).toBe(0);
		region.dispose();
		expect(retainedDisposals).toBe(1);
	});

	test("registers only foldable regions as global fold targets", () => {
		const registry = ensureFoldingRegistry();
		registry.setCurrent(undefined);
		const region = new ToolViewRegion({
			theme,
			modes: [{ id: "preview", component: component("preview") }],
			requestRender() {},
		});
		region.render(30);
		region.onMouse(mouse("move", 0, 1));
		expect(registry.current).toBeUndefined();

		region.updateModes([
			{ id: "preview", component: component("preview") },
			{ id: "full", component: component("full") },
		]);
		region.render(30);
		region.onMouse(mouse("move", 0, 1));
		expect(registry.current).toBe(region);

		region.updateModes([{ id: "preview", component: component("preview") }]);
		expect(registry.current).toBeUndefined();
		region.dispose();
	});

	test("exposes the rendered body fold at its structural transcript row", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview") },
				{ id: "full", component: component("full") },
			],
			requestRender() {},
		});
		const transcript = new ToolTranscript({ theme, action: component("action"), body: [region] });
		transcript.render(30);
		const body = transcript.getSpans()[1]?.component;
		expect(body && foldTargetAt(body, 0)).toBe(region);
		transcript.dispose();
	});
	test("supports shell, sentence, custom-marker, and markerless rows", () => {
		const views = [
			{ verb: "pwd", status: "succeeded" as const, marker: "$" },
			{ verb: "Read", status: "succeeded" as const, marker: "•", detail: "src/a.ts" },
			{ verb: "Edited", status: "succeeded" as const, marker: "✎", detail: "src/a.ts" },
			{ verb: "Indexing", status: "running" as const, marker: false },
		] satisfies ToolActionView[];
		const rendered = views.map((view) => stripTerminalSequences(new ToolAction({ theme, view }).render(80)[0]!));
		expect(rendered).toEqual(["$ pwd", "• Read · src/a.ts", "✎ Edited · src/a.ts", "Indexing"]);
	});

	test("strips terminal controls from ordinary action fields", () => {
		const rendered = renderAction({
			verb: "Read\x1b]52;c;secret\x07",
			detail: "file\x1b[2J.ts",
			status: "succeeded",
			marker: "•",
		});
		expect(rendered).toContain("Read");
		expect(rendered).toContain("file.ts");
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("\x1b]52");
	});

	test("settles provisional call rows through shared renderer state", () => {
		const state = {};
		const preview = toolCallPreview(state, component("queued"));
		expect(preview.render(20)).toEqual(["queued"]);
		settleToolCallPreview(state);
		expect(preview.render(20)).toEqual([]);
	});

	test("renders copy-friendly payload rows without an imposed gutter", () => {
		const transcript = new ToolTranscript({
			theme,
			view: { verb: "bun test", status: "succeeded", marker: "$" },
			body: [component("pass\nsecond")],
		});
		const rendered = stripTerminalSequences(transcript.render(40).join("\n"));
		expect(rendered).toBe("$ bun test\npass\nsecond");
		expect(rendered).not.toMatch(/[╭╮╰╯]/u);
		expect(rendered).not.toContain("Output");
	});

	test("disposes transcript bodies removed by replacement", () => {
		let disposed = 0;
		const removed = disposableComponent("old", () => disposed++);
		const transcript = new ToolTranscript({
			theme,
			view: { verb: "Read", status: "succeeded" },
			body: [removed],
		});
		transcript.setBody([component("new")]);
		expect(disposed).toBe(1);
		transcript.dispose();
	});

	test("multi-mode regions handle hover, click, focus, and keyboard independently", () => {
		let renders = 0;
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("one"), nextHint: "show all" },
				{ id: "detail", component: component("one\ntwo"), nextHint: "show diagnostics" },
				{ id: "full", component: component("one\ntwo\nthree"), nextHint: "collapse", activate: "preview" },
			],
			requestRender: () => renders++,
		});
		region.render(30);
		expect(region.onMouse(mouse("move", 0, 1))).toBe(true);
		region.onMouse(mouse("press", 0, 1, 0));
		region.onMouse(mouse("release", 0, 1, 0));
		expect(region.getMode()).toBe("detail");
		expect(region.render(30).join("\n")).toContain("\x1b[48;");
		region.onMouse(mouse("leave", 0, 0));
		region.setViewportFocus(true);
		expect(region.render(30).join("\n")).toContain("\x1b[48;");
		expect(region.handleViewportInput("\r")).toBe(false);
		expect(region.handleViewportInput("\x1b[C")).toBe(true);
		expect(region.getMode()).toBe("full");
		region.render(30);
		region.onMouse(mouse("press", 0, 1, 0));
		region.onMouse(mouse("release", 0, 1, 0));
		// Expanded content is not a collapse control; the owning header handles refolding.
		expect(region.getMode()).toBe("full");
		region.setMode("full");
		region.render(30);
		region.onMouse(mouse("press", 2, 20, 2));
		region.onMouse(mouse("release", 2, 20, 2));
		expect(region.getMode()).toBe("preview");
		expect(renders).toBeGreaterThan(0);
	});

	test("disclosure headers delegate keyboard and pointer folding to the region", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview"), activate: "full" },
				{ id: "full", component: component("full"), activate: "preview" },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("action"), region, () => {});
		disclosure.render(30);
		region.open();
		disclosure.render(30);
		expect(disclosure.handleViewportInput("\r")).toBe(true);
		expect(region.isFolded()).toBe(true);
		region.open();
		disclosure.render(30);
		expect(disclosure.onMouse(mouse("press", 0, 4, 0))).toBe(true);
		expect(disclosure.onMouse(mouse("release", 0, 4, 0))).toBe(true);
		expect(region.isFolded()).toBe(true);
		disclosure.dispose();
	});

	test("keeps a disclosure header hovered across streamed mode replacement", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview"), activate: "full" },
				{ id: "full", component: component("full"), activate: "preview" },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("action"), region, () => {});
		const compact = disclosure.render(30);
		expect(disclosure.onMouse(mouse("move", 0, 4))).toBe(true);
		expect(disclosure.render(30)).not.toEqual(compact);

		region.updateModes([
			{ id: "preview", component: component("next preview"), activate: "full" },
			{ id: "full", component: component("next full"), activate: "preview" },
		]);
		expect(region.isHeaderHovered()).toBe(true);
		expect(disclosure.render(30)).not.toEqual(compact);
		disclosure.dispose();
	});

	test("repaints pre-styled disclosure text for hover contrast", () => {
		const colors = tuiTheme(theme);
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview"), activate: "full" },
				{ id: "full", component: component("full"), activate: "preview" },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("\x1b[38;5;1mdim action"), region, () => {});
		disclosure.render(30);
		disclosure.onMouse(mouse("move", 0, 4));
		const hovered = disclosure.render(30).join("\n");
		expect(hovered).toContain(colors.bgAnsi("surface.hover"));
		expect(hovered).toContain(colors.fgAnsi(colors.contrastBackground(colors.color("surface.hover"))));
		expect(hovered).not.toContain("\x1b[38;5;1m");
		disclosure.dispose();
	});

	test("right-click toggles a disclosure header in either direction", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview"), activate: "full" },
				{ id: "full", component: component("full"), activate: "preview" },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("action"), region, () => {});
		disclosure.render(30);

		// Use the far edge of the full header row to keep the hit target whole-row,
		// not just the visible action text.
		expect(disclosure.onMouse(mouse("press", 0, 29, 2))).toBe(true);
		expect(disclosure.onMouse(mouse("release", 0, 29, 2))).toBe(true);
		expect(region.isExpanded()).toBe(true);

		disclosure.render(30);
		expect(disclosure.onMouse(mouse("press", 0, 29, 2))).toBe(true);
		expect(disclosure.onMouse(mouse("release", 0, 29, 2))).toBe(true);
		expect(region.isFolded()).toBe(true);
		disclosure.dispose();
	});

	test("folds from headers and expanded-body secondary clicks while primary body clicks stay payload-owned", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("preview"), activate: "full" },
				{ id: "full", component: component("full\nsecond") },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("action\ncontinuation"), region, () => {});
		disclosure.render(30);
		region.open();
		disclosure.render(30);
		expect(disclosure.onMouse(mouse("press", 1, 4, 0))).toBe(true);
		expect(disclosure.onMouse(mouse("release", 1, 4, 0))).toBe(true);
		expect(region.isFolded()).toBe(true);
		region.open();
		region.render(30);
		expect(region.onMouse(mouse("press", 0, 4, 0))).toBe(false);
		expect(region.onMouse(mouse("release", 0, 4, 0))).toBe(false);
		expect(region.onMouse(mouse("press", 0, 4, 2))).toBe(true);
		expect(region.onMouse(mouse("release", 0, 4, 2))).toBe(true);
		expect(region.isFolded()).toBe(true);
		disclosure.dispose();
	});

	test("headers open folds even when the payload has its own disclosure control", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("before\nshow full\nafter"), activationRow: 1 },
				{ id: "full", component: component("before\nmiddle\nafter") },
			],
			requestRender() {},
		});
		const disclosure = new ToolDisclosureAction(theme, component("action"), region, () => {});
		disclosure.render(30);
		region.render(30);

		expect(disclosure.onMouse(mouse("press", 0, 4, 0))).toBe(true);
		expect(disclosure.onMouse(mouse("release", 0, 4, 0))).toBe(true);
		expect(region.isExpanded()).toBe(true);
		disclosure.dispose();
	});

	test("foldable payloads without an explicit action keep ordinary body rows inert", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: component("ordinary body") },
				{ id: "full", component: component("ordinary body\nwarning details") },
			],
			requestRender() {},
		});
		const rendered = stripTerminalSequences(region.render(30).join("\n"));

		expect(rendered).toBe("ordinary body");
		expect(region.onMouse(mouse("press", 0, 4, 0))).toBe(false);
		expect(region.onMouse(mouse("release", 0, 4, 0))).toBe(false);
		expect(region.isFolded()).toBe(true);
		region.dispose();
	});

	test("mode advancement invalidates content and resets the expanded viewport", () => {
		const region = new ToolViewRegion({
			theme,
			maxHeight: 2,
			modes: [
				{ id: "preview", component: component("preview") },
				{ id: "detail", component: component("detail 0\ndetail 1\ndetail 2") },
				{ id: "full", component: component("full 0\nfull 1\nfull 2") },
			],
			requestRender() {},
		});
		region.setMode("detail");
		region.render(30);
		region.onMouse({ ...mouse("wheel", 1, 1), wheel: 1 });
		expect(stripTerminalSequences(region.render(30).join("\n"))).toContain("detail 2");
		expect(region.handleViewportInput("\x1b[C")).toBe(true);
		const full = stripTerminalSequences(region.render(30).join("\n"));
		expect(full).toContain("full 0");
		expect(full).not.toContain("detail");
		expect(region.handleViewportInput("\x1b[D")).toBe(true);
		expect(stripTerminalSequences(region.render(30).join("\n"))).toContain("detail 0");
		region.dispose();
	});

	test("all expanded regions use the shared surface and bounded payload viewport", () => {
		const region = new ToolViewRegion({
			theme,
			maxHeight: 4,
			modes: [
				{ id: "preview", component: component("preview"), nextHint: "show details" },
				{ id: "full", component: component(Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n")) },
			],
			requestRender() {},
		});
		region.render(32);
		region.onMouse(mouse("press", 0, 0, 0));
		region.onMouse(mouse("release", 0, 0, 0));
		const expanded = region.render(32);
		expect(expanded).toHaveLength(4);
		expect(expanded.every((line) => line.includes("\x1b[48;"))).toBe(true);
		expect(stripTerminalSequences(expanded[0]!).trimEnd()).toMatch(/^line 0\s+[│█]$/u);
		expect(stripTerminalSequences(expanded.at(-1)!)).toMatch(/[│█]$/u);
		region.onMouse(mouse("press", 2, 2, 0));
		region.onMouse(mouse("release", 2, 2, 0));
		expect(region.getMode()).toBe("full");
		region.onMouse(mouse("press", 2, 2, 2));
		region.onMouse(mouse("release", 2, 2, 2));
		expect(region.getMode()).toBe("preview");
	});

	test("keeps a bounded fold threshold visible and never shortens on expansion", () => {
		const activity = new ToolActivity({
			theme,
			maxHeight: 4,
			previewRows: 6,
			requestRender() {},
			view: {
				action: { verb: "Working", status: "succeeded", marker: false },
				payload: {
					kind: "text",
					text: Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"),
					revision: 1,
				},
			},
		});
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		const collapsed = stripTerminalSequences(activity.render(40).join("\n"));
		expect(collapsed).toContain("rows omitted");
		const collapsedRows = collapsed.split("\n").length;
		expect(body.onMouse(mouse("press", 1, 39, 0))).toBe(true);
		expect(body.onMouse(mouse("release", 1, 39, 0))).toBe(true);
		const expandedRows = activity.render(40).length;
		expect(expandedRows).toBeGreaterThanOrEqual(collapsedRows);
		activity.dispose();
	});

	test("keeps fold geometry bounded across wide-narrow-wide reflow", () => {
		const activity = new ToolActivity({
			theme,
			previewRows: 3,
			maxHeight: 6,
			requestRender() {},
			view: {
				action: { verb: "Working", status: "succeeded", marker: false },
				payload: {
					kind: "text",
					text: Array.from({ length: 10 }, (_, index) => `line ${index} ${"x".repeat(24)}`).join("\n"),
					revision: 1,
				},
			},
		});
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };

		const foldedWide = activity.render(80);
		const foldedNarrow = activity.render(20);
		expect(foldedWide.length).toBeLessThanOrEqual(6);
		expect(foldedNarrow.length).toBeLessThanOrEqual(6);

		const omissionRow = foldedNarrow.findIndex((line) => stripTerminalSequences(line).includes("rows omitted"));
		expect(omissionRow).toBeGreaterThan(0);
		expect(body.onMouse(mouse("press", omissionRow - 1, 2, 0))).toBe(true);
		expect(body.onMouse(mouse("release", omissionRow - 1, 2, 0))).toBe(true);

		const expandedNarrow = activity.render(20);
		expect(expandedNarrow.length).toBeGreaterThanOrEqual(foldedNarrow.length);
		expect(expandedNarrow.length).toBeLessThanOrEqual(6);
		const firstNarrowBodyRow = stripTerminalSequences(expandedNarrow[1]!).trim();
		expect(body.onMouse({ ...mouse("wheel", 1, 2), wheel: 1 })).toBe(true);
		const scrolledNarrow = activity.render(20);
		expect(stripTerminalSequences(scrolledNarrow[1]!).trim()).not.toBe(firstNarrowBodyRow);

		const expandedWide = activity.render(80);
		expect(expandedWide.length).toBeGreaterThanOrEqual(foldedWide.length);
		expect(expandedWide.length).toBeLessThanOrEqual(6);
		const firstWideBodyRow = stripTerminalSequences(expandedWide[1]!).trim();
		expect(body.onMouse({ ...mouse("wheel", 1, 2), wheel: 1 })).toBe(true);
		expect(stripTerminalSequences(activity.render(80)[1]!).trim()).not.toBe(firstWideBodyRow);
		activity.dispose();
	});

	test("places component show-full controls in the omitted middle", () => {
		const region = new ToolViewRegion({
			theme,
			modes: [
				{
					id: "preview",
					component: component("line 0\nline 1\nline 2\nline 3"),
					nextHint: "show full",
					activate: "full",
				},
				{ id: "full", component: component("full") },
			],
			requestRender() {},
		});
		const rendered = stripTerminalSequences(region.render(30).join("\n")).split("\n");
		const hintRow = rendered.findIndex((line) => line.includes("show full"));
		expect(hintRow).toBeGreaterThan(0);
		expect(hintRow).toBeLessThan(rendered.length - 1);
		expect(region.onMouse(mouse("press", hintRow, 2, 0))).toBe(true);
		expect(region.onMouse(mouse("release", hintRow, 2, 0))).toBe(true);
		expect(region.getMode()).toBe("full");
		region.dispose();
	});

	test("canceled and replaced controls clear pointer state without stealing inert keys", () => {
		let renders = 0;
		const preview = component("one");
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: preview, nextHint: "show all" },
				{ id: "full", component: component("one\ntwo") },
			],
			requestRender: () => renders++,
		});
		region.render(30);
		region.onMouse(mouse("move", 0, 1));
		region.onMouse(mouse("press", 0, 1, 0));
		expect(region.onMouse(mouse("release", 5, 20, 0))).toBe(false);
		expect(region.render(30).join("\n")).not.toContain("\x1b[48;");

		region.onMouse(mouse("move", 1, 1));
		region.updateModes([{ id: "preview", component: component("replacement") }]);
		expect(region.render(30).join("\n")).not.toContain("\x1b[48;");
		expect(region.handleViewportInput("\x1b[C")).toBe(false);
		expect(region.handleViewportInput("\x1b[D")).toBe(false);
		expect(renders).toBeGreaterThan(0);
	});

	test("streaming activity accepts text, terminal, diff, and custom visual payloads", () => {
		const action = { verb: "Working", status: "running" as const, marker: false as const };
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: { action, running: false, payload: { kind: "text", text: "hello", revision: 1 } },
		});
		expect(stripTerminalSequences(activity.render(40).join("\n"))).toContain("hello");
		expect(stripTerminalSequences(activity.render(40).join("\n"))).not.toContain("expand transcript");
		activity.update({
			action,
			running: false,
			payload: { kind: "text", text: Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n"), revision: 2 },
		});
		expect(stripTerminalSequences(activity.render(40).join("\n"))).toContain("… 4 rows omitted …");
		expect(stripTerminalSequences(activity.render(40).join("\n"))).not.toContain("expand transcript");
		expect(stripTerminalSequences(activity.render(40).join("\n"))).not.toContain("show full output");
		activity.update({ action, running: false, payload: { kind: "terminal", text: "progress 1%\rprogress 2%" } });
		activity.update({ action, running: false, payload: { kind: "component", preview: component("custom") } });
		const custom = stripTerminalSequences(activity.render(40).join("\n"));
		expect(custom).toContain("custom");
		expect(custom).not.toContain("expand");
		activity.dispose();
	});

	test("expands a diff from its fold row without an appended tail control", () => {
		const model = parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,30 +1,30 @@", ...Array.from({ length: 30 }, (_, index) => ` line ${index}`)].join(
				"\n",
			),
		);
		const activity = new ToolActivity({
			theme,
			fullRows: 40,
			requestRender() {},
			view: { action: { verb: "Diff", status: "succeeded", marker: false }, payload: { kind: "diff", model } },
		});
		const collapsed = stripTerminalSequences(activity.render(80).join("\n"));
		expect(collapsed).toContain("@@");
		expect(collapsed).not.toContain("show full diff");
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		expect(body.onMouse(mouse("press", 12, 10, 0))).toBe(true);
		expect(body.onMouse(mouse("release", 12, 10, 0))).toBe(true);
		const expandedLines = activity.render(80);
		const expanded = stripTerminalSequences(expandedLines.join("\n"));
		expect(expandedLines.length).toBeGreaterThanOrEqual(collapsed.split("\n").length);
		expect(expandedLines.at(-1)).toMatch(/[│█]/u);
		expect(expanded).toContain("line 21");
		expect(expanded).not.toContain("line 29");
		expect(expanded).not.toContain("show full diff");
		const header = expandedLines[0];
		const firstBodyRow = expandedLines[1];
		for (let index = 0; index < 3; index += 1) expect(body.onMouse({ ...mouse("wheel", 1, 10), wheel: 1 })).toBe(true);
		const scrolledLines = activity.render(80);
		expect(scrolledLines[0]).toBe(header);
		expect(scrolledLines[1]).not.toBe(firstBodyRow);
		expect(stripTerminalSequences(scrolledLines.join("\n"))).toContain("line 29");
		activity.dispose();
	});

	test("diff omission hover paints semantic gutter and content backgrounds", () => {
		const colors = tuiTheme(theme);
		const view = new UnifiedDiffView({
			model: parseUnifiedDiff(
				["--- a/x", "+++ b/x", "@@ -1,5 +1,5 @@", " one", " two", " three", " four", " five"].join("\n"),
			),
			theme: colors,
			viewport: { maxRows: 3, selection: "head-tail" },
		});
		const region = new ToolViewRegion({
			theme,
			modes: [
				{ id: "preview", component: view, activationRow: "omission" },
				{ id: "full", component: component("full") },
			],
			requestRender() {},
		});
		const rest = region.render(60);
		const omissionRow = view.getOmissionRow();
		expect(omissionRow).toBeDefined();
		expect(rest[omissionRow!]).toContain(colors.bgAnsi("diff.hunk"));
		expect(rest[omissionRow!]).toContain(colors.bgAnsi("diff.hunkGutter"));
		expect(region.onMouse(mouse("move", omissionRow!, 0))).toBe(true);
		const gutterHovered = region.render(60);
		expect(gutterHovered[omissionRow!]).toContain(colors.bgAnsi("diff.hunkHover"));
		expect(gutterHovered[omissionRow!]).toContain(colors.bgAnsi("diff.hunkGutterHover"));
		region.onMouse(mouse("leave", omissionRow!, 5));
		expect(region.onMouse(mouse("move", omissionRow!, 59))).toBe(true);
		const hovered = region.render(60);
		expect(hovered[omissionRow!]).toContain(colors.bgAnsi("diff.hunkHover"));
		expect(hovered[omissionRow!]).toContain(colors.bgAnsi("diff.hunkGutterHover"));
		expect(hovered[omissionRow!]?.split(colors.bgAnsi("diff.hunkHover")).length).toBe(2);
		expect(hovered[omissionRow!]?.split(colors.bgAnsi("diff.hunkGutterHover")).length).toBe(2);
		expect(hovered[omissionRow!]).not.toBe(rest[omissionRow!]);
		region.onMouse(mouse("leave", omissionRow!, 5));
		expect(region.render(60)[omissionRow!]).toBe(rest[omissionRow!]);
		region.dispose();
	});

	test("keeps wrapped diff previews bounded without removing expanded scrolling", () => {
		const model = parseUnifiedDiff(
			[
				"--- a/x",
				"+++ b/x",
				"@@ -1,30 +1,30 @@",
				...Array.from({ length: 30 }, (_, index) => ` ${index} ${"wrapped ".repeat(30)}`),
			].join("\n"),
		);
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: { action: { verb: "Diff", status: "succeeded", marker: false }, payload: { kind: "diff", model } },
		});
		const collapsed = activity.render(20);
		expect(collapsed.length).toBeLessThanOrEqual(26);
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		let omissionRow = -1;
		for (const [index, line] of collapsed.entries()) {
			if (stripTerminalSequences(line).includes("@@")) omissionRow = index;
		}
		expect(omissionRow).toBeGreaterThan(0);
		expect(body.onMouse(mouse("press", omissionRow - 1, 10, 0))).toBe(true);
		expect(body.onMouse(mouse("release", omissionRow - 1, 10, 0))).toBe(true);
		const expanded = activity.render(20);
		expect(expanded.length).toBeGreaterThanOrEqual(collapsed.length);
		expect(expanded.length).toBeLessThanOrEqual(27);
		const firstBodyRow = expanded[1];
		expect(body.onMouse({ ...mouse("wheel", 1, 10), wheel: 1 })).toBe(true);
		expect(activity.render(20)[1]).not.toBe(firstBodyRow);
		activity.dispose();
	});

	test("derives diff disclosure from rendered wrapping instead of source rows", () => {
		const model = parseUnifiedDiff(["--- a/x", "+++ b/x", "@@ -1 +1 @@", ` ${"wrapped ".repeat(80)}`].join("\n"));
		expect(model.sourceRows).toBe(4);
		const activity = new ToolActivity({
			theme,
			previewRows: 6,
			requestRender() {},
			view: { action: { verb: "Diff", status: "succeeded", marker: false }, payload: { kind: "diff", model } },
		});
		const collapsed = activity.render(20);
		const omissionRow = collapsed.findIndex((line) => stripTerminalSequences(line).includes("wrapped diff"));
		expect(omissionRow).toBeGreaterThan(0);
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		expect(body.onMouse(mouse("press", omissionRow - 1, 10, 0))).toBe(true);
		expect(body.onMouse(mouse("release", omissionRow - 1, 10, 0))).toBe(true);
		expect(activity.render(20).length).toBeGreaterThan(collapsed.length);
		activity.dispose();
	});

	test("renders a first text stream whose revision starts at zero", () => {
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action: { verb: "Working", status: "running", marker: false },
				payload: { kind: "text", text: "visible", revision: 0 },
			},
		});
		expect(stripTerminalSequences(activity.render(40).join("\n"))).toContain("visible");
		activity.dispose();
	});

	test("adds a disclosure when preview output wraps past the row budget", () => {
		const activity = new ToolActivity({
			theme,
			previewRows: 2,
			requestRender() {},
			view: {
				action: { verb: "Working", status: "succeeded", marker: false },
				payload: { kind: "text", text: "a very long line that wraps", revision: 1 },
			},
		});
		const rendered = stripTerminalSequences(activity.render(8).join("\n"));
		expect(rendered).toContain("›");
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		body.onMouse(mouse("press", 0, 5, 0));
		body.onMouse(mouse("release", 0, 5, 0));
		const expanded = stripTerminalSequences(activity.render(8).join("\n"));
		expect(expanded.replace(/\s/gu, "")).toContain("averylonglinethatwraps");
		expect(expanded).not.toContain("rows omitted");
		activity.dispose();
	});

	test("resets the region after payload removal before its first render", () => {
		const action = { verb: "Working", status: "succeeded" as const, marker: false as const };
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: { action, payload: { kind: "text", text: "first", revision: 1 } },
		});
		const originalBody = activity.children[1];
		activity.update({ action });
		activity.update({ action, payload: { kind: "text", text: "second", revision: 2 } });
		expect(activity.children[1]).not.toBe(originalBody);
		expect(stripTerminalSequences(activity.render(30).join("\n"))).toContain("second");
		activity.dispose();
	});

	test("focuses nested children and gives them input before outer scrolling", () => {
		const focus: boolean[] = [];
		const input: string[] = [];
		const nested: Component & {
			setViewportFocus(focused: boolean): void;
			handleViewportInput(data: string): boolean;
		} = {
			render: () => ["nested"],
			invalidate() {},
			setViewportFocus(focused) {
				focus.push(focused);
			},
			handleViewportInput(data) {
				input.push(data);
				return true;
			},
		};
		const region = new ToolViewRegion({
			theme,
			maxHeight: 2,
			modes: [
				{ id: "preview", component: component("preview") },
				{ id: "full", component: nested },
			],
			requestRender() {},
		});
		region.setViewportFocus(true);
		region.setMode("full");
		region.render(30);
		expect(focus).toEqual([true]);
		expect(region.handleViewportInput("\x1b[B")).toBe(true);
		expect(input).toEqual(["\x1b[B"]);
		region.dispose();
	});

	test("counts the action row in a bounded activity fold", () => {
		const activity = new ToolActivity({
			theme,
			maxHeight: 4,
			requestRender() {},
			view: {
				action: { verb: "Working", status: "succeeded", marker: false },
				mode: "full",
				payload: { kind: "text", text: "one\ntwo\nthree\nfour\nfive", revision: 1 },
			},
		});
		expect(activity.render(30)).toHaveLength(4);
		activity.dispose();
	});

	test("routes an explicit cumulative terminal tail without treating replacements as append-only", async () => {
		const action = { verb: "Working", status: "running" as const, marker: false as const };
		const cumulative = `\x1b[31m${"red ".repeat(80)}`;
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: { action, payload: { kind: "terminal", text: cumulative, revision: 1, update: "cumulative" } },
		});
		activity.update({
			action,
			payload: {
				kind: "terminal",
				text: cumulative.slice(-100),
				revision: 2,
				update: "cumulative-tail",
			},
		});
		await Bun.sleep(0);
		expect(activity.render(40).join("\n")).toContain("31m");
		activity.dispose();
	});

	test("append-only stream state resets when switching from terminal to text and back", async () => {
		let wake: (() => void) | undefined;
		const rendered = () => new Promise<void>((resolve) => (wake = resolve));
		let nextRender = rendered();
		const action = { verb: "Working", status: "running" as const, marker: false as const };
		const activity = new ToolActivity({
			theme,
			requestRender() {
				wake?.();
				wake = undefined;
			},
			view: { action, payload: { kind: "terminal", text: "first!", revision: 1, update: "cumulative" } },
		});
		await nextRender;
		expect(stripTerminalSequences(activity.render(40).join("\n"))).toContain("first!");
		activity.update({ action, payload: { kind: "text", text: "middle", revision: 1, update: "cumulative" } });
		nextRender = rendered();
		activity.update({ action, payload: { kind: "terminal", text: "second", revision: 1, update: "cumulative" } });
		await nextRender;
		const final = stripTerminalSequences(activity.render(40).join("\n"));
		expect(final).toContain("second");
		expect(final).not.toContain("first");
		activity.dispose();
	});

	test("append-only stream state resets when switching from text to terminal and back", async () => {
		let wake: (() => void) | undefined;
		const rendered = () => new Promise<void>((resolve) => (wake = resolve));
		let nextRender = rendered();
		const action = { verb: "Working", status: "running" as const, marker: false as const };
		const activity = new ToolActivity({
			theme,
			requestRender() {
				wake?.();
				wake = undefined;
			},
			view: { action, payload: { kind: "text", text: "first!", revision: 1, update: "cumulative" } },
		});
		nextRender = rendered();
		activity.update({ action, payload: { kind: "terminal", text: "middle", revision: 1, update: "cumulative" } });
		await nextRender;
		activity.update({ action, payload: { kind: "text", text: "second", revision: 1, update: "cumulative" } });
		const final = stripTerminalSequences(activity.render(40).join("\n"));
		expect(final).toContain("second");
		expect(final).not.toContain("middle");
		expect(final).not.toContain("first!");
		activity.dispose();
	});

	test("stream updates preserve a click already captured by the payload region", () => {
		const action = { verb: "Working", status: "running" as const, marker: false as const };
		const initial = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: { action, running: false, payload: { kind: "text", text: initial, revision: 1 } },
		});
		activity.render(40);
		const body = activity.children[1]!;
		const interactive = body as Component & { onMouse(event: TuiMouseEvent): boolean };
		expect(interactive.onMouse(mouse("press", 2, 5, 0))).toBe(true);

		activity.update({
			action,
			running: false,
			payload: { kind: "text", text: `${initial}\nline 9`, revision: 2 },
		});
		expect(activity.children[1]).toBe(body);
		expect(interactive.onMouse(mouse("release", 2, 5, 0))).toBe(true);
		expect(stripTerminalSequences(activity.render(40).join("\n"))).not.toContain("collapse");
		activity.dispose();
	});

	test("recreates a fold region after its payload disappears", () => {
		const action = { verb: "Working", status: "succeeded" as const, marker: false as const };
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action,
				payload: { kind: "text", text: Array.from({ length: 9 }, (_, row) => `first ${row}`).join("\n"), revision: 1 },
			},
		});
		activity.render(40);
		activity.update({ action });
		activity.render(40);
		activity.update({
			action,
			payload: { kind: "text", text: Array.from({ length: 9 }, (_, row) => `second ${row}`).join("\n"), revision: 2 },
		});
		activity.render(40);
		const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
		body.onMouse(mouse("move", 2, 5));
		expect(ensureFoldingRegistry().current).toBeDefined();
		expect(body.onMouse(mouse("press", 2, 5, 0))).toBe(true);
		expect(body.onMouse(mouse("release", 2, 5, 0))).toBe(true);
		expect(stripTerminalSequences(activity.render(40).join("\n"))).toContain("second 8");
		activity.dispose();
	});

	test("keeps failure details collapsed until their own region is activated", () => {
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action: { verb: "Skill failed", detail: "missing", status: "failed" },
				failure: 'Unknown skill "missing"',
			},
		});
		const compact = stripTerminalSequences(activity.render(60).join("\n"));
		expect(compact).toMatch(
			new RegExp(
				`^${escapeRegExp(icon("error"))} Skill failed · missing\\s+${escapeRegExp(icon("expand-closed"))}$`,
				"u",
			),
		);
		expect(compact).not.toContain("Unknown skill");
		const action = activity.children[0] as Component & { onMouse(event: TuiMouseEvent): boolean };
		activity.render(60);
		action.onMouse(mouse("move", 0, 4));
		action.onMouse(mouse("press", 0, 4, 0));
		expect(action.onMouse(mouse("release", 2, 80, 0))).toBe(false);
		expect(activity.render(60).join("\n")).not.toContain("\x1b[48;");
		expect(action.onMouse(mouse("press", 0, 4, 0))).toBe(true);
		expect(action.onMouse(mouse("release", 0, 4, 0))).toBe(true);
		expect(stripTerminalSequences(activity.render(60).join("\n"))).toContain('Unknown skill "missing"');
		action.onMouse(mouse("press", 0, 4, 2));
		action.onMouse(mouse("release", 0, 4, 2));
		expect(stripTerminalSequences(activity.render(60).join("\n"))).not.toContain('Unknown skill "missing"');
		activity.update({
			action: { verb: "Skill failed", detail: "missing", status: "failed" },
			failure: 'Unknown skill "missing"\x1b]52;c;secret\x07',
			mode: "full",
		});
		const expanded = activity.render(60).join("\n");
		expect(expanded).not.toContain("\x1b]52");
		expect(stripTerminalSequences(expanded)).toContain('Unknown skill "missing"');
		expect(stripTerminalSequences(activity.render(60).join("\n"))).not.toContain("show error");
		action.onMouse(mouse("move", 0, 4));
		expect(activity.render(60).join("\n")).not.toBe(expanded);
		action.onMouse(mouse("press", 0, 4, 0));
		action.onMouse(mouse("release", 0, 4, 0));
		expect(stripTerminalSequences(activity.render(60).join("\n"))).not.toContain('Unknown skill "missing"');
		activity.dispose();
	});

	test("live actions share a disposable animation capability", () => {
		const live = new LiveToolAction({
			theme,
			view: { verb: "Streaming", status: "running", marker: false },
			requestRender() {},
			reducedMotion: true,
		});
		expect(stripTerminalSequences(live.render(40)[0]!)).toContain("Streaming");
		live.dispose();
	});

	test("live actions render the configured shared activity style", () => {
		configureTuiAppearance({ activityMarker: "off", shimmer: "glow" });
		const live = new LiveToolAction({
			theme,
			view: { verb: "Streaming", status: "running", marker: false },
			requestRender() {},
		});
		expect(stripTerminalSequences(live.render(40)[0]!)).toStartWith("Streaming");
		configureTuiAppearance({ activityMarker: "pulse" });
		expect(stripTerminalSequences(live.render(40)[0]!)).toStartWith("● Streaming");
		live.dispose();
	});
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function component(text: string) {
	return { render: () => text.split("\n"), invalidate() {} };
}

function disposableComponent(text: string, dispose: () => void) {
	return { ...component(text), dispose };
}

function renderAction(view: ToolActionView): string {
	return stripTerminalSequences(new ToolAction({ theme, view }).render(80)[0]!);
}

function mouse(type: TuiMouseEvent["type"], row: number, col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}
