import { describe, expect, test } from "bun:test";
import { generateColor256, rgb } from "../src/color/palette.ts";
import { parseBackgroundAnsi } from "../src/color/theme.ts";

describe("color palette", () => {
	test("parses only the requested basic SGR destination", () => {
		expect(parseBackgroundAnsi("\x1b[31m\x1b[44m")).toEqual(rgb(0, 0, 128));
		expect(parseBackgroundAnsi("\x1b[91m\x1b[104m")).toEqual(rgb(0, 0, 255));
	});

	test("fills the color cube and grayscale ramp from theme anchors", () => {
		const anchors = [
			rgb(10, 20, 30),
			rgb(200, 20, 20),
			rgb(20, 200, 20),
			rgb(200, 200, 20),
			rgb(20, 20, 200),
			rgb(200, 20, 200),
			rgb(20, 200, 200),
			rgb(230, 230, 230),
		];
		const palette = generateColor256([...anchors, ...anchors], anchors[0]!, anchors[7]!);
		expect(palette).toHaveLength(256);
		expect(palette[16]).toEqual(anchors[0]);
		expect(palette[21]).toEqual(anchors[4]);
		expect(palette[46]).toEqual(anchors[2]);
		expect(palette[196]).toEqual(anchors[1]);
		expect(palette[231]).toEqual(anchors[7]);
		expect(palette[232]).not.toEqual(palette[16]);
		expect(palette[255]).not.toEqual(palette[231]);
	});
});
