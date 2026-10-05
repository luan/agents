import { afterEach, beforeEach, expect, test } from "bun:test";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../src/color/theme.ts";
import { semanticMarkdownTheme } from "../src/content/text.ts";
import { installMarkdownTableBridge } from "../src/host/markdown-table-bridge.ts";
import harmonious from "../themes/harmonious.json";

const theme = new Theme(harmonious.colors, harmonious.colors, "truecolor");
const disposers: Array<() => void> = [];
beforeEach(() => initTheme("dark", false));
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

function markdown(source: string): Markdown {
	return new Markdown(source, 0, 0, {
		...semanticMarkdownTheme(theme),
		// Theme attributes use Chalk, which disables styling in non-TTY tests.
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	});
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

test("tables use padded columns and muted rules without an outer box or vertical grid", () => {
	disposers.push(installMarkdownTableBridge(() => theme));
	const lines = markdown("| Name | Value |\n| --- | --- |\n| Alpha | One |\n| Beta | Two |").render(40);
	expect(plain(lines)).toEqual([
		" Name     Value",
		"───────  ───────",
		" Alpha    One",
		"───────  ───────",
		" Beta     Two",
	]);
	expect(lines[0]).toContain(tuiTheme(theme).fgAnsi("heading"));
	expect(lines[1]).toContain(tuiTheme(theme).fgAnsi("border"));
});

test.each([12, 20, 40, 80])("wrapped Unicode cells preserve text and inline styles at %i columns", (width) => {
	disposers.push(installMarkdownTableBridge(() => theme));
	const lines = markdown(
		"| Name | Details |\n| --- | --- |\n| A | 日本語 **bold** and `code` with [link](https://example.com) |\n| B | 👩‍💻 é │ ┼ ┌ |",
	).render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	const text = plain(lines).join("\n");
	for (const word of ["日本語", "bold", "code", "link", "👩‍💻", "é", "│", "┼", "┌"]) {
		expect(text.replace(/\s/gu, "")).toContain(word);
	}
	expect(lines.join("\n")).toContain("\x1b[1m");
	expect(lines.join("\n")).toContain(tuiTheme(theme).fgAnsi("warning"));
	expect(lines.join("\n")).toContain("https://example.com");
});

test.each([1, 2, 3, 4, 5])("narrow tables retain Pi's readable fallback at %i columns", (width) => {
	const source = "| A | B |\n| --- | --- |\n| X | Y |";
	const native = markdown(source).render(width);
	disposers.push(installMarkdownTableBridge(() => theme));
	expect(markdown(source).render(width)).toEqual(native);
});

test.each([1, 2, 3, 4, 8])("tables with %i columns stay within the viewport", (columns) => {
	disposers.push(installMarkdownTableBridge(() => theme));
	const row = `|${Array.from({ length: columns }, () => " X ").join("|")}|`;
	const divider = `|${Array.from({ length: columns }, () => "---").join("|")}|`;
	const component = markdown(`${row}\n${divider}\n${row}`);
	for (let width = 1; width <= 100; width += 1) {
		const lines = component.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(plain(lines).join("").match(/X/gu)).toHaveLength(columns * 2);
	}
});

test("multiple columns, empty cells, surrounding prose, and resizing retain their layout", () => {
	disposers.push(installMarkdownTableBridge(() => theme));
	const component = markdown("Before\n\n| A | B | C |\n|---|---|---|\n| One | | Three |\n\nAfter");
	for (const width of [20, 40, 30, 80]) {
		const lines = component.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const text = plain(lines).join("\n");
		expect(text).toContain("Before");
		expect(text).toContain("After");
		expect(text.replace(/\s/gu, "")).toContain("OneThree");
		expect(text).not.toMatch(/[│┌┐└┘├┤┼┬┴]/u);
	}
});

test("non-table Markdown and fenced table source keep their native formatting", () => {
	const source =
		"# Heading\n\n**Bold**, `code`, and a [link](https://example.com).\n\n```text\n| A | B |\n|---|---|\n```";
	const native = markdown(source).render(40);
	disposers.push(installMarkdownTableBridge(() => theme));
	expect(markdown(source).render(40)).toEqual(native);
});

test("shared leases do not stack and the last disposal restores native tables", () => {
	const source = "| A | B |\n|---|---|\n| X | Y |";
	const native = markdown(source).render(40);
	const first = installMarkdownTableBridge(() => theme);
	const second = installMarkdownTableBridge(() => theme);
	disposers.push(first, second);
	const open = markdown(source).render(40);
	expect(plain(open).join("\n")).not.toContain("│");
	first();
	first();
	expect(markdown(source).render(40)).toEqual(open);
	second();
	expect(markdown(source).render(40)).toEqual(native);
});
