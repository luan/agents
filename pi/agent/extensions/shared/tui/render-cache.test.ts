import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type CardTheme, framedBlock } from "./card";
import { RenderedLineCache } from "./render-cache";
import { paintAnsiBackgroundRow } from "./text";

const theme: CardTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

describe("RenderedLineCache", () => {
	test("reuses lines across identical renders", () => {
		const cache = new RenderedLineCache();
		let layouts = 0;
		const produce = () => {
			layouts++;
			return ["a"];
		};

		for (let frame = 0; frame < 10; frame++) cache.get(80, "same", produce);

		expect(layouts).toBe(1);
	});

	test("re-lays out when width changes", () => {
		const cache = new RenderedLineCache();
		const produce = (width: number) => () => [`w${width}`];

		expect(cache.get(80, "same", produce(80))).toEqual(["w80"]);
		expect(cache.get(40, "same", produce(40))).toEqual(["w40"]);
		expect(cache.get(80, "same", produce(80))).toEqual(["w80"]);
	});

	test("re-lays out when the content key changes", () => {
		const cache = new RenderedLineCache();

		expect(cache.get(80, "one", () => ["one"])).toEqual(["one"]);
		expect(cache.get(80, "two", () => ["two"])).toEqual(["two"]);
	});

	test("clear() forces the next render to lay out again", () => {
		const cache = new RenderedLineCache();
		let layouts = 0;
		const produce = () => {
			layouts++;
			return ["a"];
		};

		cache.get(80, "same", produce);
		cache.clear();
		cache.get(80, "same", produce);

		expect(layouts).toBe(2);
	});

	test("caches empty output instead of re-laying it out", () => {
		const cache = new RenderedLineCache();
		let layouts = 0;
		const produce = () => {
			layouts++;
			return [] as string[];
		};

		cache.get(80, "same", produce);
		cache.get(80, "same", produce);

		expect(layouts).toBe(1);
	});
});
describe("ANSI backgrounds", () => {
	// The colour actually in effect where a piece of text is drawn, which is what
	// the terminal paints — not merely which escapes appear somewhere in the line.
	const effectiveBackground = (rendered: string, text: string): string | undefined =>
		[...rendered.slice(0, rendered.indexOf(text)).matchAll(/\u001b\[(4[0-7]|49|10[0-7]|48;[0-9;]+)m/g)].at(-1)?.[1];

	test("keeps a background the line painted for itself", () => {
		const card = "\u001b[48;2;24;26;33m";
		// A diff row: its own added-row background, then syntax colours inside it.
		const row = "\u001b[48;2;20;53;31m 2 + \u001b[38;5;244mconst added\u001b[39m;\u001b[0m";
		const rendered = paintAnsiBackgroundRow(row, 40, card);

		// Re-applying the card colour after every style change overwrote the row
		// band before a character of it was drawn, so diffs rendered flat.
		expect(effectiveBackground(rendered, "const added")).toBe("48;2;20;53;31");
		// It comes back once the row clears its own background, so the padding
		// past the end of the row is card-coloured rather than transparent.
		expect(rendered).toContain(`\u001b[0m${card}`);
	});

	test("reapplies row background after every SGR style change", () => {
		const background = "\u001b[48;5;17m";
		const line = "\u001b[38;5;244mCommand\u001b[39m";
		const rendered = paintAnsiBackgroundRow(line, 20, background);

		expect(visibleWidth(rendered)).toBe(20);
		expect(rendered.split(background).length - 1).toBe(3);
	});
});

describe("Card caching", () => {
	const spec = {
		header: "Subagents",
		sections: [{ lines: ["├─ agent-1 running", "└─ agent-2 done"] }],
	};

	test("cached renders match a freshly built card at every width", () => {
		const card = framedBlock(theme, spec);

		for (const width of [80, 40, 80, 120, 40]) {
			expect(card.render(width)).toEqual(framedBlock(theme, spec).render(width));
		}
	});

	test("invalidate() drops cached lines", () => {
		const card = framedBlock(theme, spec);
		const first = card.render(80);
		card.invalidate();

		expect(card.render(80)).not.toBe(first);
		expect(card.render(80)).toEqual(first);
	});
});
