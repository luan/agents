import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { icon, tuiTheme } from "pi-libtui";
import { annotationIcon, plainPill, transcriptPillContent } from "../src/core/pills.ts";
import type { DraftAnnotation } from "../src/core/types.ts";
import { renderPill } from "../src/ui/pills.ts";
import {
	AnnotationMarkerController,
	decorateAnnotationDetail,
	decorateAnnotationMarkers,
	shouldDecorateAnnotationMarkers,
} from "../src/ui/screen-markers.ts";

// type-boundary: marker tests provide only Theme methods exercised by pills and detail cards.
type ThemeBoundary = unknown;
const themeBoundary: ThemeBoundary = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
	bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
	getBgAnsi: () => "\x1b[48;5;8m",
	bold: (text: string) => text,
};
const theme = themeBoundary as Theme;
function draft(overrides: Partial<DraftAnnotation> = {}): DraftAnnotation {
	return {
		id: "a",
		index: 1,
		token: "\ue000",
		selection: {
			messageId: "m",
			messageIdStability: "stable",
			text: "x",
			shape: "character",
			start: { row: 4, col: 2 },
			end: { row: 4, col: 3 },
			screenStart: { row: 4, col: 2 },
			screenEnd: { row: 4, col: 3 },
			source: { quote: { exact: "x" } },
		},
		content: "note",
		...overrides,
	};
}
function annotationPill(index: number, content = "note"): string {
	return plainPill({ icon: { glyph: annotationIcon(content) }, label: `#${index}` });
}

describe("draft transcript markers", () => {
	test("overlays instead of changing visible width", () => {
		const screen = ["abcdefghij", "", "", "", "abcd      "];
		const value = draft({ selection: { ...draft().selection, text: "abc" } });
		const result = decorateAnnotationMarkers(screen, [value], 10, theme);
		expect(stripTerminalSequences(result[4]!)).toBe(`abc${annotationPill(1)}`);
		expect(visibleWidth(result[4]!)).toBeLessThanOrEqual(10);
	});

	test("does not paint a default-background tail onto a styled line", () => {
		const screen = ["\x1b[48;5;4mabcd\x1b[0m"];
		const result = decorateAnnotationMarkers(
			screen,
			[{ ...draft(), selection: { ...draft().selection, text: "abcd", screenEnd: { row: 0, col: 4 } } }],
			20,
			theme,
		);
		expect(stripTerminalSequences(result[0]!)).toBe(`abcd${annotationPill(1)}`);
	});

	test("keeps a styled message background across an inline handle", () => {
		const screen = ["\x1b[48;5;4mabcdefghij          \x1b[0m"];
		const result = decorateAnnotationMarkers(
			screen,
			[{ ...draft(), selection: { ...draft().selection, screenEnd: { row: 0, col: 2 } } }],
			20,
			theme,
		);
		expect(visibleWidth(result[0]!)).toBe(20);
		expect(result[0]).toContain("\x1b[48;5;4m");
	});

	test("line markers anchor after the visible line instead of the selection", () => {
		const value = draft({ selection: { ...draft().selection, shape: "line", text: "1234567890" } });
		const result = decorateAnnotationMarkers(
			["1234567890"],
			[{ ...value, selection: { ...value.selection, screenEnd: { row: 0, col: 2 } } }],
			10,
			theme,
		);
		expect(stripTerminalSequences(result[0]!)).toBe(`1234${annotationPill(1)}`);
	});

	test("renders multiple line markers at one anchor consecutively", () => {
		const comment = draft({
			selection: { ...draft().selection, shape: "line", text: "12345678901234567890", screenEnd: { row: 0, col: 2 } },
		});
		const reaction = draft({
			id: "b",
			index: 2,
			selection: {
				...draft().selection,
				shape: "line",
				text: "12345678901234567890",
				screenEnd: { row: 0, col: 2 },
			},
			content: "👍 Looks good",
		});
		const result = decorateAnnotationMarkers(["12345678901234567890"], [comment, reaction], 20, theme);
		expect(stripTerminalSequences(result[0]!)).toBe(`1234567${annotationPill(1)}${annotationPill(2, "👍 Looks good")}`);
	});

	test("remaps a line endpoint through the current scroll viewport", () => {
		const viewport = { x: 1, y: 0, width: 10, height: 1, scrollTop: 4 };
		const value = draft({
			selection: { ...draft().selection, shape: "line", end: { row: 4, col: 5 }, screenEnd: { row: 9, col: 20 } },
		});
		const result = decorateAnnotationMarkers(["1234567890"], [value], 10, theme, viewport);
		expect(stripTerminalSequences(result[0]!)).toBe(`1234${annotationPill(1)}`);
	});

	test("recomputes rows from the current scroll layout", () => {
		const viewport = { x: 1, y: 1, width: 10, height: 3, scrollTop: 3 };
		const result = decorateAnnotationMarkers(
			["..........", "..........", ".........."],
			[draft()],
			10,
			theme,
			viewport,
		);
		expect(stripTerminalSequences(result[2]!)).toContain(`${icon("comment")} #1`);
	});

	test("hides a marker when the captured endpoint has no matching selected text", () => {
		const { source: _source, ...nativeSelection } = draft().selection;
		const value = draft({ selection: { ...nativeSelection, text: "界", screenEnd: { row: 0, col: 1 } } });
		const result = decorateAnnotationMarkers(["1234567890"], [value], 10, theme);
		expect(stripTerminalSequences(result[0]!)).toBe("1234567890");
	});

	test("uses the mapped copy-mode endpoint for character placement", () => {
		const viewport = { x: 0, y: 0, width: 10, height: 1, scrollTop: 0 };
		const base = draft();
		const value = draft({ selection: { ...base.selection, text: "界", end: { row: 0, col: 1 } } });
		const result = decorateAnnotationMarkers(["1234567890"], [value], 10, theme, viewport);
		expect(stripTerminalSequences(result[0]!)).toBe(`1${annotationPill(1)}890`);
	});

	test("places character markers after the selected text instead of at line end", () => {
		const value = draft({
			selection: {
				...draft().selection,
				text: "that",
				end: { row: 0, col: 19 },
				screenEnd: { row: 0, col: 19 },
			},
		});
		const rendered = stripTerminalSequences(
			decorateAnnotationMarkers(["Hi again! Glad that looked good."], [value], 40, theme)[0]!,
		);
		expect(rendered.indexOf(annotationPill(1))).toBe(19);
	});

	test("uses the visible selected text when the captured endpoint is stale", () => {
		const value = draft({
			selection: {
				...draft().selection,
				text: "What",
				screenEnd: { row: 0, col: 200 },
			},
		});
		const line = `Selected text: “What”${" ".repeat(20)}`;
		const rendered = stripTerminalSequences(decorateAnnotationMarkers([line], [value], 40, theme)[0]!);
		expect(rendered.indexOf(annotationPill(1))).toBe("Selected text: “What".length);
	});

	test("does not reattach a short quote inside unrelated visible text", () => {
		const value = draft({
			selection: {
				...draft().selection,
				text: "ls",
				end: { row: 9, col: 2 },
				screenEnd: { row: 0, col: 2 },
				source: { quote: { exact: "ls", prefix: "run ", suffix: " now" } },
			},
		});
		const line = "It also adds a new task without context";
		const rendered = stripTerminalSequences(decorateAnnotationMarkers([line], [value], 40, theme)[0]!);
		expect(rendered).toBe(line);
	});

	test("keeps a marker attached when an earlier region inserts transcript rows", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "target",
				end: { row: 0, col: 6 },
				screenEnd: { row: 0, col: 6 },
				source: { quote: { exact: "target", prefix: "keep ", suffix: " here" } },
			},
		});
		const lines = ["expanded content", "keep target here", "later content"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		expect(stripTerminalSequences(rendered[0]!)).toBe("expanded content");
		expect(stripTerminalSequences(rendered[1]!)).toContain(`keep target${annotationPill(1)}`);
	});

	test("moves a hovered detail card with its marker after transcript rows insert", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 8, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "target",
				end: { row: 0, col: 11 },
				screenEnd: { row: 0, col: 11 },
				source: { quote: { exact: "target" } },
			},
		});
		const initialLines = ["keep target here", "later content"];
		const initialScreen = [...initialLines, ...Array.from({ length: 6 }, () => "")];
		const controller = new AnnotationMarkerController();

		controller.decorate(initialScreen, [value], 40, theme, viewport, initialLines);
		const initialHit = controller.hitAt(11, 0);
		expect(initialHit?.draftId).toBe(value.id);
		controller.setHover(initialHit);
		const initiallyHovered = controller.decorate(initialScreen, [value], 40, theme, viewport, initialLines);
		const initialDetailRow = initiallyHovered.findIndex((line) =>
			stripTerminalSequences(line).includes("Selected: target"),
		);
		expect(initialDetailRow).toBe(2);

		const expandedLines = ["expanded content", ...initialLines];
		const expandedScreen = [...expandedLines, ...Array.from({ length: 5 }, () => "")];
		const reflowed = controller.decorate(expandedScreen, [value], 40, theme, viewport, expandedLines);

		expect(controller.hitAt(11, 1)?.draftId).toBe(value.id);
		const reflowedDetailRow = reflowed.findIndex((line) => stripTerminalSequences(line).includes("Selected: target"));
		expect(reflowedDetailRow).toBe(3);
		expect(stripTerminalSequences(reflowed[initialDetailRow]!)).not.toContain("Selected: target");
	});

	test("reanchors a unique visible selection when a fold leaves the fullscreen viewport mapping stale", () => {
		const value = draft({
			selection: {
				...draft().selection,
				text: "changed50",
				end: { row: 2, col: 9 },
				screenEnd: { row: 2, col: 9 },
				source: { quote: { exact: "changed50" } },
			},
		});
		const transcriptLines = ["header", "inserted", "changed50"];
		const staleViewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 1 };
		const rendered = decorateAnnotationMarkers(
			["header", "changed50", "footer"],
			[value],
			40,
			theme,
			staleViewport,
			transcriptLines,
		);

		expect(stripTerminalSequences(rendered[1]!)).toContain(`changed50${annotationPill(1)}`);
	});

	test("keeps a stale marker hidden when selected text is visibly ambiguous", () => {
		const value = draft({
			selection: {
				...draft().selection,
				text: "target",
				end: { row: 2, col: 6 },
				screenEnd: { row: 2, col: 6 },
				source: { quote: { exact: "target" } },
			},
		});
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 1 };
		const rendered = decorateAnnotationMarkers(["target one", "middle", "target two"], [value], 40, theme, viewport, [
			"header",
			"inserted",
			"target",
		]);

		expect(rendered.map(stripTerminalSequences)).toEqual(["target one", "middle", "target two"]);
	});

	test("uses quote context to disambiguate repeated selected text", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "staff",
				source: { quote: { exact: "staff", prefix: "second ", suffix: " target" } },
			},
		});
		const lines = ["first staff one", "second staff target", "third staff end"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		expect(stripTerminalSequences(rendered[0]!)).toBe("first staff one");
		expect(stripTerminalSequences(rendered[1]!)).toContain(`second staff${annotationPill(1)}`);
	});

	test("uses the quote endpoint when repeated text occurs on one transcript row", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 1, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "staff",
				source: { quote: { exact: "staff", prefix: "first ", suffix: " staff" } },
			},
		});
		const lines = ["first staff staff"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		const plain = stripTerminalSequences(rendered[0]!);
		expect(plain.indexOf(annotationPill(1))).toBe("first staff".length);
	});

	test("accepts a final line selection whose quote includes the omitted document newline", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 2, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "last line\n",
				shape: "line",
				source: { quote: { exact: "last line\n" } },
			},
		});
		const lines = ["prior content", "last line"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		expect(stripTerminalSequences(rendered[0]!)).toBe(lines[0]!);
		expect(stripTerminalSequences(rendered[1]!)).toContain(`last line${annotationPill(1)}`);
	});

	test("anchors a multiline line marker to the final selected row", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "first line\nsecond line\n",
				shape: "line",
				source: { quote: { exact: "first line\nsecond line\n" } },
			},
		});
		const lines = ["first line", "second line", "following line"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		expect(stripTerminalSequences(rendered[0]!)).toBe(lines[0]!);
		expect(stripTerminalSequences(rendered[1]!)).toContain(`second line${annotationPill(1)}`);
		expect(stripTerminalSequences(rendered[2]!)).toBe(lines[2]!);
	});

	test("restores the logical transcript background after selection paint", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 1, scrollTop: 0 };
		const value = draft({
			selection: {
				...draft().selection,
				text: "target",
				end: { row: 0, col: 6 },
				screenEnd: { row: 0, col: 6 },
				source: { quote: { exact: "target" } },
			},
		});
		const screen = ["\x1b[48;5;226mtarget and more\x1b[0m"];
		const logical = ["target and more"];
		const rendered = decorateAnnotationMarkers(screen, [value], 40, theme, viewport, logical)[0]!;
		const pillStart = rendered.indexOf("\x1b[49m");
		const pillEnd = rendered.indexOf("\x1b[0m", pillStart);
		expect(pillStart).toBeGreaterThanOrEqual(0);
		expect(pillEnd).toBeGreaterThan(pillStart);
		expect(rendered.slice(pillStart, pillEnd)).not.toContain("48;5;226m");
	});

	test("hides an ambiguous marker instead of floating on unrelated content", () => {
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 0 };
		const value = draft({ selection: { ...draft().selection, text: "staff", source: { quote: { exact: "staff" } } } });
		const lines = ["first staff one", "second staff target", "third staff end"];
		const rendered = decorateAnnotationMarkers(lines, [value], 40, theme, viewport, lines);
		expect(rendered.map(stripTerminalSequences)).toEqual(lines);
	});

	test("treats overlapping repeated text as ambiguous too", () => {
		const viewport = { x: 0, y: 0, width: 20, height: 1, scrollTop: 0 };
		const value = draft({
			selection: { ...draft().selection, text: "ana", source: { quote: { exact: "ana" } } },
		});
		const lines = ["anana"];
		const rendered = decorateAnnotationMarkers(lines, [value], 20, theme, viewport, lines);
		expect(rendered.map(stripTerminalSequences)).toEqual(lines);
	});

	test("records only the clickable body hit target", () => {
		const controller = new AnnotationMarkerController();
		controller.decorate(
			["abcdefghij"],
			[{ ...draft(), selection: { ...draft().selection, text: "abc", screenEnd: { row: 0, col: 2 } } }],
			10,
			theme,
		);
		expect(controller.hitAt(4, 0)?.draftId).toBe("a");
		expect(controller.hitAt(10, 0)).toBeUndefined();
		expect(controller.setHover(controller.hitAt(4, 0))).toBe(true);
		expect(controller.setHover(controller.hitAt(4, 0))).toBe(false);
	});

	test("keeps the semantic pill surface stable and restores each destination cap", () => {
		const backgrounds: string[] = [];
		const recordingBoundary: ThemeBoundary = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => {
				backgrounds.push(color);
				return text;
			},
			getBgAnsi: (color: string) => (color === "selectedBg" ? "\x1b[48;5;8m" : "\x1b[48;5;4m"),
			bold: (text: string) => text,
		};
		const recordingTheme = recordingBoundary as Theme;
		const colors = tuiTheme(recordingTheme);
		const semanticBackground = colors.bgAnsi("surface.selected");
		const controller = new AnnotationMarkerController();
		const value = {
			...draft(),
			selection: { ...draft().selection, text: "abcdefghij", screenEnd: { row: 0, col: 2 } },
		};
		const destinations = [
			"\x1b[49m", // default transcript surface
			"\x1b[48;2;40;40;40m", // truecolor selected surface
			"\x1b[48;5;22m", // diff added
			"\x1b[48;5;52m", // diff removed
			"\x1b[48;5;24m", // diff hunk
			"\x1b[48;5;226m\x1b[7m", // cursor/inverse paint
		];
		for (const destination of destinations) {
			const rendered = controller.decorate([`${destination}abcdefghij\x1b[49m`], [value], 10, recordingTheme)[0]!;
			expect(rendered).toContain(semanticBackground);
			expect(rendered).toContain(destination);
			const pill = renderPill(recordingTheme, transcriptPillContent(value), {
				surface: "base",
				foreground: "accent",
				surroundingBackgroundAnsi: destination,
			});
			expect(pill).toStartWith(destination);
			expect(pill).toEndWith(destination);
			expect(visibleWidth(pill)).toBe(visibleWidth(plainPill(transcriptPillContent(value))));
		}
		expect(backgrounds).toEqual([]);
	});

	test("drops marker hits when the source scrolls outside the clipped viewport", () => {
		const controller = new AnnotationMarkerController();
		const value = draft({
			selection: { ...draft().selection, end: { row: 9, col: 2 }, screenEnd: { row: 1, col: 2 } },
		});
		controller.decorate(["..........", ".........."], [value], 10, theme, {
			x: 0,
			y: 0,
			width: 10,
			height: 2,
			scrollTop: 8,
		});
		controller.setHover(controller.hitAt(2, 1));
		const offscreen = controller.decorate(["..........", ".........."], [value], 10, theme, {
			x: 0,
			y: 0,
			width: 10,
			height: 2,
			scrollTop: 10,
		});
		expect(stripTerminalSequences(offscreen.join("\n"))).toBe("..........\n..........");
		expect(controller.getBounds()).toBeUndefined();
	});

	test("hides a quoted marker and its detail when the anchored row scrolls away", () => {
		const controller = new AnnotationMarkerController();
		const value = draft({
			selection: {
				...draft().selection,
				text: "target",
				end: { row: 0, col: 6 },
				screenEnd: { row: 0, col: 6 },
				source: { quote: { exact: "target" } },
			},
		});
		const lines = ["target", "following"];
		const viewport = { x: 0, y: 0, width: 40, height: 3, scrollTop: 0 };
		const screen = [lines[0]!, "", "", "", "", "", "", ""];
		controller.decorate(screen, [value], 40, theme, viewport, lines);
		controller.setHover(controller.hitAt(6, 0));
		const hovered = controller.decorate(screen, [value], 40, theme, viewport, lines);
		expect(hovered.map(stripTerminalSequences).join("\n")).toContain("Selected: target");
		const scrolled = controller.decorate(
			[lines[1]!, "", "", "", "", "", "", ""],
			[value],
			40,
			theme,
			{ ...viewport, scrollTop: 1 },
			lines,
		);
		expect(stripTerminalSequences(scrolled[0]!)).toBe(lines[1]!);
		expect(controller.getBounds()).toBeUndefined();
	});

	test("clips marker rows at the viewport edges and recomputes them after resize", () => {
		const controller = new AnnotationMarkerController();
		const atRow = (id: string, row: number): DraftAnnotation =>
			draft({
				id,
				selection: {
					...draft().selection,
					end: { row, col: 2 },
					screenEnd: { row: 99, col: 2 },
				},
			});
		const drafts = [atRow("top", 1), atRow("first", 2), atRow("second", 3), atRow("bottom", 4)];
		const screen = ["..........", "..........", "..........", ".........."];
		const viewport = { x: 0, y: 1, width: 10, height: 2, scrollTop: 2 };
		controller.decorate(screen, drafts, 10, theme, viewport);
		expect(controller.hitAt(2, 0)).toBeUndefined();
		expect(controller.hitAt(2, 1)?.draftId).toBe("first");
		expect(controller.hitAt(2, 2)?.draftId).toBe("second");
		expect(controller.hitAt(2, 3)).toBeUndefined();

		controller.decorate(screen, drafts, 10, theme, { ...viewport, height: 1 });
		expect(controller.hitAt(2, 1)?.draftId).toBe("first");
		expect(controller.hitAt(2, 2)).toBeUndefined();
		expect(controller.getBounds()).toEqual({ x: 2, y: 1, width: 6, height: 1 });
	});

	test("hover paints a stable non-overlay detail card with selected and comment text", () => {
		const controller = new AnnotationMarkerController();
		const value = {
			...draft(),
			selection: { ...draft().selection, screenEnd: { row: 0, col: 2 }, text: "selected words" },
		};
		const screen = Array.from({ length: 8 }, () => `${"selected words line"}${" ".repeat(21)}`);
		controller.decorate(screen, [value], 40, theme);
		const hit = controller.hitAt(14, 0)!;
		controller.setHover(hit);
		const result = controller.decorate(screen, [value], 40, theme).map(stripTerminalSequences);
		expect(result.join("\n")).toContain("Selected: selected words");
		expect(result.join("\n")).toContain("Comment: note");
		expect(result.join("\n")).toMatch(/[╭╮╰╯│]/u);
		expect(result.join("\n")).toContain("Annotation #1");
		expect(result.join("\n")).toContain("Selected: selected words");
		expect(result.join("\n")).toContain("Comment: note");
		expect(controller.hitAt(14, 0)).toEqual(hit);
	});

	test("detail cards wrap content and mark bounded overflow visibly", () => {
		const value = draft({
			selection: { ...draft().selection, text: "selected ".repeat(12) },
			content: "comment ".repeat(16),
		});
		const result = decorateAnnotationDetail(
			Array.from({ length: 10 }, () => " ".repeat(24)),
			value,
			{ row: 0, col: 0 },
			24,
			theme,
		).map(stripTerminalSequences);
		expect(result.join("\n")).toContain("Selected:");
		expect(result.join("\n")).toContain("…");
	});

	test("suppresses marker decoration for local and host overlays", () => {
		expect(shouldDecorateAnnotationMarkers(false, false)).toBe(true);
		expect(shouldDecorateAnnotationMarkers(true, false)).toBe(false);
		expect(shouldDecorateAnnotationMarkers(false, true)).toBe(false);
	});
});
