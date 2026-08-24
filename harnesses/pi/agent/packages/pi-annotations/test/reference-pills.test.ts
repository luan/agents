import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, icon, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { serializeEnvelope } from "../src/core/envelope.ts";
import { plainPill } from "../src/core/pills.ts";
import { AnnotationPresentationGroups } from "../src/core/presentation.ts";
import { AnnotationStore } from "../src/core/store.ts";
import type { ResponseAnnotation } from "../src/core/types.ts";
import { renderAnnotationMarker, stripAnnotationMarker } from "../src/ui/annotation-markers.ts";
import { renderPill } from "../src/ui/pills.ts";
import { handleReferencePillMouse, ReferencePillController } from "../src/ui/reference-pills.ts";

// type-boundary: reference tests provide only Theme methods used by pills and detail cards.
type ThemeBoundary = unknown;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	getBgAnsi: () => "\x1b[48;5;8m",
	bold: (text: string) => text,
} as ThemeBoundary as Theme;
const annotation: ResponseAnnotation = { text: "selected reference", annotation: "explain this" };
const url = "pi-annotation://show/turn/1";

function pillContent(index = 1, glyph = icon("comment")) {
	return { icon: { glyph }, label: `#${index}` } as const;
}

function mouse(type: TuiMouseEvent["type"], row = 0, col = 1): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("ReferencePillController", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("keeps inert reference markers unstyled until their screen background is known", () => {
		const controller = new ReferencePillController();
		const pill = renderAnnotationMarker(plainPill(pillContent()), url);
		expect(pill).not.toContain("\x1b[48;");
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "user" as const } : undefined;
		const rendered = controller.decorate([pill], 40, theme, resolve)[0]!;
		expect(stripTerminalSequences(rendered)).toContain("#1");
	});

	test("resolves inert point markers and paints a natural-width bordered hover detail", () => {
		const controller = new ReferencePillController();
		const renderedPill = renderPill(theme, pillContent(), { surface: "base", foreground: "accent" });
		const pill = renderAnnotationMarker(renderedPill, url);
		const screen = [` ${pill} after${" ".repeat(30)}`, ...Array.from({ length: 7 }, () => " ".repeat(40))];
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const plain = controller.decorate(screen, 40, theme, resolve);
		expect(stripTerminalSequences(plain[0]!)).not.toContain(url);
		expect(stripTerminalSequences(plain[0]!)).toContain(" after");
		expect(stripTerminalSequences(plain[0]!)).toContain(stripTerminalSequences(renderedPill));
		expect(plain.join("\n")).not.toContain("\x1b]8;;");
		controller.setHover(controller.hitAt(2, 0));
		const hovered = controller.decorate(screen, 40, theme, resolve).map(stripTerminalSequences).join("\n");
		expect(hovered).toContain("Selected: selected");
		expect(hovered).toContain("Comment: explain this");
		expect(hovered).toMatch(/[╭╮╰╯│]/u);
		expect(hovered).not.toContain("\x1b]8;;");
	});

	test("uses rendered screen paint when no logical destination is available", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const screen = [`\x1b[48;5;226m${marker} after\x1b[0m`];
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;

		const rendered = controller.decorate(screen, 40, theme, resolve)[0]!;
		const screenBackground = "\x1b[48;5;226m";
		const pillStart = rendered.indexOf(screenBackground, rendered.indexOf(screenBackground) + screenBackground.length);
		const pillEnd = rendered.indexOf("after", pillStart);
		expect(pillStart).toBeGreaterThanOrEqual(0);
		expect(pillEnd).toBeGreaterThan(pillStart);
		expect(rendered.slice(pillStart, pillEnd)).toContain("48;5;226m");
	});

	test("restores the logical transcript background around reference caps", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const screen = [`\x1b[48;5;226m${marker} after\x1b[0m`];
		const logical = ["\x1b[48;5;22mreference after\x1b[0m"];
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;

		const rendered = controller.decorate(screen, 40, theme, resolve, false, logical)[0]!;
		const pillStart = rendered.indexOf("\x1b[48;5;22m");
		const pillEnd = rendered.indexOf("after", pillStart);
		expect(pillStart).toBeGreaterThanOrEqual(0);
		expect(pillEnd).toBeGreaterThan(pillStart);
		expect(rendered.slice(pillStart, pillEnd)).toContain("48;5;22m");
		expect(rendered.slice(pillStart, pillEnd)).not.toContain("48;5;226m");
	});

	test("keeps a user reference pill visible after native selection paint", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const source = [`can you ${marker} after`];
		const prepared = controller.prepareSelection(source);
		const selected = prepared.map((line) => `\x1b[7m${line}\x1b[27m`);
		const logical = [`\x1b[48;5;22mcan you ${plainPill(pillContent())} after\x1b[0m`];
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "user" as const } : undefined;

		const rendered = controller.decorate(selected, 40, theme, resolve, true, logical)[0]!;
		const colors = tuiTheme(theme);
		expect(rendered).toContain(colors.bgAnsi("badge.neutral"));
		expect(rendered).toContain("\x1b[48;5;22m");
		expect(stripTerminalSequences(rendered)).toContain("can you");
		expect(stripTerminalSequences(rendered)).toContain("#1");
	});

	test("consumes hover and clicks without activating the internal geometry marker", () => {
		const controller = new ReferencePillController();
		let changes = 0;
		const pill = renderAnnotationMarker(
			renderPill(theme, pillContent(), { surface: "base", foreground: "accent" }),
			url,
		);
		controller.decorate([pill], 20, theme, (candidate) =>
			candidate === url ? { annotation, index: 1, surface: "base" } : undefined,
		);
		expect(handleReferencePillMouse(controller, mouse("drag"), () => undefined)).toBe(false);
		expect(handleReferencePillMouse(controller, mouse("wheel"), () => undefined)).toBe(false);
		expect(
			handleReferencePillMouse(controller, mouse("enter"), () => {
				changes += 1;
			}),
		).toBe(true);
		expect(
			handleReferencePillMouse(controller, mouse("move"), () => {
				changes += 1;
			}),
		).toBe(true);
		expect(
			handleReferencePillMouse(controller, mouse("leave"), () => {
				changes += 1;
			}),
		).toBe(true);
		expect(
			handleReferencePillMouse(controller, mouse("press", 0, 1), () => {
				changes += 1;
			}),
		).toBe(true);
		expect(
			handleReferencePillMouse(controller, mouse("release", 0, 1), () => {
				changes += 1;
			}),
		).toBe(true);
		expect(changes).toBe(2);
	});

	test("leaves native-selected links untouched", () => {
		const controller = new ReferencePillController();
		const renderedPill = renderPill(theme, pillContent(), { surface: "base", foreground: "accent" });
		const pill = renderAnnotationMarker(renderedPill, url);
		const screen = [pill];
		const resolved = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;

		const result = controller.decorate(screen, 20, theme, resolved, true);
		expect(stripTerminalSequences(result[0]!)).toBe(stripTerminalSequences(renderedPill));
		expect(result[0]).not.toContain("pi-annotation:");
		expect(controller.hitAt(1, 0)?.url).toBe(url);
		controller.setHover(controller.hitAt(1, 0));
		const prepared = controller.prepareSelection(screen);
		const hovered = controller
			.decorate([prepared[0]!, ...Array.from({ length: 7 }, () => " ".repeat(20))], 20, theme, resolved, true)
			.map(stripTerminalSequences)
			.join("\n");
		expect(hovered).toContain("Selected: selected");
	});

	test("strips reference metadata while an overlay suppresses badge decoration", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);

		const cleaned = controller.prepareSelection([`${marker} transcript`, "overlay content"]);

		expect(cleaned[0]).toContain(`${plainPill(pillContent())} transcript`);
		expect(cleaned.join("\n")).not.toContain("pi-annotation:");
		expect(cleaned[1]).toBe("overlay content");
	});

	test("clears prepared hits and hover when the source marker leaves the frame", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const cleaned = controller.prepareSelection([`visible ${marker}`]);
		controller.decorate(cleaned, 40, theme, resolve, true);
		const hit = controller.hitAt(8, 0);
		expect(hit?.url).toBe(url);
		controller.setHover(hit);

		const offscreen = controller.prepareSelection(["the annotated source is now outside the viewport"]);
		const rendered = controller.decorate(offscreen, 40, theme, resolve, true);
		expect(rendered[0]).toBe("the annotated source is now outside the viewport");
		expect(controller.getBounds()).toBeUndefined();
		expect(controller.hitAt(8, 0)).toBeUndefined();
	});

	test("reference cleanup preserves Pi and libtui cursor markers", () => {
		const cursor = "\x1b_pi:c\x07\x1b_pi-libtui:cursor:insertion\x07";
		const line = `${cursor}${renderAnnotationMarker("[annotation #1]", "pi-annotation://turn/1")}`;
		expect(stripAnnotationMarker(line)).toBe(`${cursor}[annotation #1]`);
	});

	test("replaces the complete pill when native selection crosses it", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const source = new Markdown(`before ${marker} What would you like to build?`, 0, 0, getMarkdownTheme()).render(
			80,
		)[0]!;
		const start = 5;
		const end = 20;
		const selected = sliceByColumn(source, start, end - start, true);
		const native = `${sliceByColumn(source, 0, start, true)}\x1b[7m${selected}\x1b[27m${sliceByColumn(source, end, 80 - end, true)}`;
		const prepared = controller.prepareSelection([native]);
		const resolved = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const rendered = controller.decorate(prepared, 80, theme, resolved, true);
		const plain = stripTerminalSequences(rendered[0]!);
		expect(plain.match(/#1/g)?.length).toBe(1);
		expect(plain.match(//g)?.length).toBe(1);
		expect(plain).toContain("What would you like to build?");
	});

	test("ignores a dangling native-selection marker instead of painting a line tail", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const source = new Markdown(`before ${marker} What would you like to build?`, 0, 0, getMarkdownTheme()).render(
			80,
		)[0]!;
		const start = 7;
		const end = 13;
		const native =
			sliceByColumn(source, 0, start, true) +
			`\x1b[7m${sliceByColumn(source, start, end - start, true)}\x1b[27m` +
			sliceByColumn(source, end, 80 - end, true);
		const prepared = controller.prepareSelection([native]);
		const resolved = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const rendered = controller.decorate(prepared, 80, theme, resolved, true);
		const plain = stripTerminalSequences(rendered[0]!);

		expect(plain.match(/#1/g)?.length).toBe(1);
		expect(plain).toContain("What would you like to build?");
		expect(plain.length).toBeLessThanOrEqual(80);
	});

	test("rebuilds a prepared pill after a later cursor decorator paints inside it", () => {
		const controller = new ReferencePillController();
		const marker = renderAnnotationMarker(plainPill(pillContent()), url);
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const prepared = controller.prepareSelection([`before ${marker} after`]);
		const cursorPainted = prepared.map((line) => line.replace("", "\x1b[1;38;5;16;48;5;255m\x1b[0m"));

		const rendered = controller.decorate(cursorPainted, 40, theme, resolve);

		expect(stripTerminalSequences(rendered[0]!)).toContain(
			`before ${stripTerminalSequences(renderPill(theme, pillContent(), { surface: "base", foreground: "accent" }))}`,
		);
		expect(stripTerminalSequences(rendered[0]!)).toContain("after");
		expect(rendered[0]).not.toContain("48;5;255");
		expect(controller.hitAt(7, 0)?.url).toBe(url);
	});

	test("rebuilds every pill once when a selected line contains multiple references", () => {
		const controller = new ReferencePillController();
		const secondUrl = "pi-annotation://show/x/2";
		const secondAnnotation: ResponseAnnotation = { text: "second reference", annotation: "note" };
		const first = renderAnnotationMarker(plainPill(pillContent()), url);
		const second = renderAnnotationMarker(plainPill(pillContent(2)), secondUrl);
		const prepared = controller.prepareSelection([`left ${first} middle ${second} right`]);
		const selected = prepared.map((line) => `\x1b[7m${line}\x1b[27m`);
		const resolve = (candidate: string) =>
			candidate === url
				? { annotation, index: 1, surface: "base" as const }
				: candidate === secondUrl
					? { annotation: secondAnnotation, index: 2, surface: "base" as const }
					: undefined;

		const rendered = controller.decorate(selected, 60, theme, resolve);
		const plain = stripTerminalSequences(rendered[0]!);

		expect(plain.match(/#1/g)?.length).toBe(1);
		expect(plain.match(/#2/g)?.length).toBe(1);
		expect(rendered[0]).not.toContain("pi-annotation:");
		expect(plain).toContain("left");
		expect(plain).toContain("middle");
		expect(plain).toContain("right");
	});

	test("clips a reference pill to the available screen width", () => {
		const controller = new ReferencePillController();
		const pill = renderAnnotationMarker(
			renderPill(theme, pillContent(), { surface: "base", foreground: "accent" }),
			url,
		);
		controller.decorate([pill], 3, theme, (candidate) =>
			candidate === url ? { annotation, index: 1, surface: "base" } : undefined,
		);
		const rendered = controller.decorate([pill], 3, theme, (candidate) =>
			candidate === url ? { annotation, index: 1, surface: "base" } : undefined,
		)[0]!;
		expect(stripTerminalSequences(rendered).length).toBeLessThanOrEqual(3);
		expect(controller.hitAt(2, 0)?.rect.width).toBe(3);
	});

	test("replaces inert markers without leaving terminal link sequences", () => {
		const controller = new ReferencePillController();
		const renderedPill = renderPill(theme, pillContent(), { surface: "base", foreground: "accent" });
		const marker = renderAnnotationMarker(renderedPill, url);
		const resolve = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const rendered = controller.decorate([`${marker} after`], 40, theme, resolve)[0]!;
		expect(rendered).not.toContain("\x1b]8;");
		expect(stripTerminalSequences(rendered)).toContain(" after");
		expect(controller.hitAt(1, 0)?.url).toBe(url);
	});

	test("does not carry a pill link onto the expanded annotation rows", () => {
		const groups = new AnnotationPresentationGroups();
		const projected = groups.projectUser(
			serializeEnvelope(
				[{ text: "today", annotation: "hehehe" }].map((annotation, index) => ({
					index: index + 1,
					id: "annotation",
					selection: {
						messageId: "message",
						messageIdStability: "stable",
						text: annotation.text,
						shape: "character" as const,
						start: { row: 0, col: 0 },
						end: { row: 0, col: annotation.text.length },
						screenStart: { row: 0, col: 0 },
						screenEnd: { row: 0, col: annotation.text.length },
					},
					content: annotation.annotation,
					token: "token",
				})),
				"request",
			),
			(_annotation, index) =>
				renderAnnotationMarker(plainPill(pillContent(index, "💬")), groups.referenceUrl(index, "base")),
		);
		const lines = new Markdown(projected, 0, 0, getMarkdownTheme()).render(80);

		for (const line of lines.filter(
			(line) =>
				stripTerminalSequences(line).includes("Selected text") || stripTerminalSequences(line).includes("Comment"),
		)) {
			expect(line).not.toContain("\x1b]8;");
		}
	});

	test("rebuilds a reference pill from the current appearance", () => {
		const controller = new ReferencePillController();
		const resolved = (candidate: string) =>
			candidate === url ? { annotation, index: 1, surface: "base" as const } : undefined;
		const original = renderAnnotationMarker(
			renderPill(theme, pillContent(), { surface: "base", foreground: "accent" }),
			url,
		);
		controller.decorate([original], 20, theme, resolved);
		configureTuiAppearance({ iconPack: "emoji", powerline: false });
		const updated = controller.decorate([original], 20, theme, resolved)[0]!;
		expect(stripTerminalSequences(updated)).toContain("💬 #1");
		expect(stripTerminalSequences(updated)).toContain("▐");
	});

	test("keeps annotation headers attached to their user message", () => {
		const store = new AnnotationStore();
		store.add(
			{
				messageId: "message",
				messageIdStability: "stable",
				text: "looked good",
				shape: "character",
				start: { row: 0, col: 0 },
				end: { row: 0, col: 11 },
				screenStart: { row: 2, col: 0 },
				screenEnd: { row: 2, col: 11 },
			},
			"👍 Looks good",
		);
		const groups = new AnnotationPresentationGroups();
		const projected = groups.projectUser(serializeEnvelope(store.get(), "Hi again!"), (_annotation, index) =>
			renderAnnotationMarker(
				renderPill(theme, pillContent(index), { surface: "user" }),
				groups.referenceUrl(index, "user"),
			),
		);
		const controller = new ReferencePillController();
		const rendered = controller.decorate([projected.split("\n")[2]!], 40, theme, (candidate) =>
			groups.resolve(candidate),
		);
		expect(stripTerminalSequences(rendered[0]!)).toContain("👍 #1");
		expect(controller.hitAt(1, 0)?.surface).toBe("user");
	});
});
