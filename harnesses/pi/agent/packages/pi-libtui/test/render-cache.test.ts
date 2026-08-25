import { describe, expect, test } from "bun:test";
import { RenderedLinesCache } from "../src/render-cache.ts";

describe("RenderedLinesCache", () => {
	test("uses exact width and revision keys with bounded widths", () => {
		const cache = new RenderedLinesCache({ maxWidths: 3, maxContentKeysPerWidth: 2 });
		const first = cache.get(80, "r1", () => ["same"]);
		expect(cache.get(80, "r1", () => ["other"])).toBe(first);
		cache.get(80, "r2", () => ["second"]);
		cache.get(80, "r3", () => ["third"]);
		expect(cache.get(80, "r1", () => ["new first"])).not.toBe(first);
		for (let width = 1; width < 1_000; width++) cache.get(width, "r", () => [String(width)]);
		expect(cache.widthCount).toBe(3);
	});

	test("normalizes non-finite width and content limits", () => {
		const cache = new RenderedLinesCache({ maxWidths: Number.NaN, maxContentKeysPerWidth: Number.POSITIVE_INFINITY });
		for (let width = 0; width < 100; width++) {
			for (let revision = 0; revision < 10; revision++) {
				cache.get(width, String(revision), () => [`${width}:${revision}`]);
			}
		}
		expect(cache.widthCount).toBe(4);
	});
});
