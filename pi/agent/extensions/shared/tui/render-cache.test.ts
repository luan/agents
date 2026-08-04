import { describe, expect, test } from "bun:test";
import { framedBlock, type OmpTheme } from "./omp-card";
import { RenderedLineCache } from "./render-cache";

const theme: OmpTheme = {
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

describe("OmpCard caching", () => {
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
