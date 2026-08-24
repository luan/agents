import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { icon, tuiTheme } from "pi-libtui";
import { annotationIcon, plainPill } from "../src/core/pills.ts";
import type { AnnotationSelection, DraftAnnotation } from "../src/core/types.ts";
import { annotationDetailLines, renderPill } from "../src/ui/pills.ts";

// type-boundary: pill tests provide only the Theme methods used by the generic primitive and feature card.
type ThemeBoundary = unknown;
function recordingTheme(backgrounds: string[], bolds: string[] = []): Theme {
	const boundary: ThemeBoundary = {
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => {
			backgrounds.push(color);
			return text;
		},
		getBgAnsi: (color: string) => (color === "selectedBg" ? "\x1b[48;5;8m" : "\x1b[48;5;0m"),
		bold: (text: string) => {
			bolds.push(text);
			return text;
		},
	};
	return boundary as Theme;
}
const selection: AnnotationSelection = {
	messageId: "m",
	messageIdStability: "stable",
	text: "selected",
	shape: "character",
	start: { row: 0, col: 0 },
	end: { row: 0, col: 1 },
	screenStart: { row: 0, col: 0 },
	screenEnd: { row: 0, col: 1 },
};
const draft: DraftAnnotation = { id: "a", index: 1, token: "\ue000", selection, content: "note" };

describe("pill surfaces", () => {
	test("uses the first emoji grapheme as the annotation handle", () => {
		expect(annotationIcon("👍 Looks good")).toBe("👍");
		expect(annotationIcon("👩‍💻 ships")).toBe("👩‍💻");
		expect(annotationIcon("🇺🇸 ships")).toBe("🇺🇸");
		expect(annotationIcon("1️⃣ ships")).toBe("1️⃣");
		expect(annotationIcon("Looks good")).toBe(icon("comment"));
	});

	test("uses explicit surrounding surface context and its alternate", () => {
		const backgrounds: string[] = [];
		const bolds: string[] = [];
		const theme = recordingTheme(backgrounds, bolds);
		const base = renderPill(theme, { icon: "comment", label: "base" }, { surface: "base" });
		const baseHover = renderPill(theme, { icon: "comment", label: "base-hover" }, { surface: "base", state: "hover" });
		const user = renderPill(theme, { icon: "comment", label: "user" }, { surface: "user" });
		const hovered = renderPill(theme, { icon: "comment", label: "user-hover" }, { surface: "user", state: "hover" });
		const colors = tuiTheme(theme);
		expect(base).toContain(colors.bgAnsi("surface.selected"));
		expect(user).toContain(colors.bgAnsi("badge.neutral"));
		for (const pill of [baseHover, hovered]) expect(pill).toContain(colors.bgAnsi("surface.hover"));
		expect(hovered).toContain("user-hover");
		expect(bolds).toEqual(["base-hover", "user-hover"]);
	});

	test("chooses a subdued semantic surface when the preferred pill background matches its destination", () => {
		const theme = recordingTheme([]);
		const colors = tuiTheme(theme);
		for (const { state, preferred, fallback } of [
			{ state: "normal" as const, preferred: "surface.selected" as const, fallback: "badge.neutral" as const },
			{ state: "hover" as const, preferred: "surface.hover" as const, fallback: "surface.raised" as const },
		]) {
			const destination = colors.bgAnsi(preferred);
			const pill = renderPill(
				theme,
				{ icon: "comment", label: "#1" },
				{
					surface: "base",
					state,
					surroundingBackgroundAnsi: destination,
				},
			);
			expect(pill).toStartWith(destination);
			expect(pill).toEndWith(destination);
			expect(pill).toContain(colors.bgAnsi(fallback));
			expect(colors.bgAnsi(fallback)).not.toBe(destination);
		}
	});

	test("does not invent an underlying user-message background", () => {
		const boundary: ThemeBoundary = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => `\x1b[48;5;0m${text}\x1b[49m`,
			getBgAnsi: (color: string) => (color === "userMessageBg" ? "\x1b[48;5;4m" : "\x1b[48;5;0m"),
			bold: (text: string) => text,
		};
		const theme = boundary as Theme;
		const pill = renderPill(theme, { icon: "comment", label: "user" }, { surface: "user" });
		expect(pill).toEndWith("\x1b[49m");
	});

	test("keeps body colors semantic while powerline caps restore the destination", () => {
		const theme = recordingTheme([]);
		const colors = tuiTheme(theme);
		const content = { icon: "comment" as const, label: "#1" };
		const plainWidth = visibleWidth(plainPill(content));
		for (const context of [
			{ surface: "base" as const, background: "surface.selected" as const },
			{ surface: "user" as const, background: "badge.neutral" as const },
			{ surface: "base" as const, state: "hover" as const, background: "surface.hover" as const },
			{ surface: "user" as const, state: "hover" as const, background: "surface.hover" as const },
		]) {
			const destination = "\x1b[48;5;4m";
			const pill = renderPill(theme, content, {
				surface: context.surface,
				state: context.state,
				surroundingBackgroundAnsi: destination,
			});
			expect(pill).toStartWith(destination);
			expect(pill).toEndWith(destination);
			expect(pill).toContain(colors.bgAnsi(context.background));
			expect(visibleWidth(pill)).toBe(plainWidth);
		}
	});

	test("keeps wide emoji handles aligned with their plain marker width", () => {
		const theme = recordingTheme([]);
		const content = { icon: { glyph: "👩‍💻" }, label: "#7" } as const;
		const rendered = renderPill(theme, content, {
			surface: "base",
			foreground: "accent",
			surroundingBackgroundAnsi: "\x1b[48;5;22m",
		});
		expect(visibleWidth(rendered)).toBe(visibleWidth(plainPill(content)));
	});

	test("hover detail has a visible semantic border and interactive alternate surface", () => {
		const backgrounds: string[] = [];
		const lines = annotationDetailLines(recordingTheme(backgrounds), draft, 30);
		expect(stripTerminalSequences(lines[0]!)).toMatch(/^╭─ Annotation #1 ─+╮$/u);
		expect(stripTerminalSequences(lines[1]!)).toContain("Selected: selected");
		expect(stripTerminalSequences(lines.at(-1)!)).toMatch(/^╰─+╯$/u);
		expect(lines.join("\n")).toContain("Selected: selected");
		expect(lines.join("\n")).toContain(tuiTheme(recordingTheme([])).bgAnsi("surface.raised"));
		expect(backgrounds).toEqual([]);
		expect(new Set(lines.map(visibleWidth))).toEqual(new Set([20]));
	});

	test("user-surface hover details remain on the contrasting background", () => {
		const backgrounds: string[] = [];
		const theme = recordingTheme(backgrounds);
		const lines = annotationDetailLines(theme, draft, 30, "user");
		expect(lines.every((line) => line.includes(tuiTheme(theme).bgAnsi("surface.raised")))).toBe(true);
	});
});
