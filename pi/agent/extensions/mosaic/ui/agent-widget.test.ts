import { describe, expect, test } from "bun:test";
import { renderMosaicHudIdentityPrefix, type Theme } from "./agent-widget";

describe("mosaic agent widget identity", () => {
	test("renders hex mosaic colors without theme token lookup", () => {
		const theme: Theme = {
			fg: (color, text) => {
				if (color !== "accent") throw new Error(`Unknown theme color: ${color}`);
				return text;
			},
			bold: (text) => text,
		};

		const rendered = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme);

		expect(rendered).toContain("\x1b[38;2;243;139;168m▐▌\x1b[39m");
		expect(rendered).toContain("\x1b[38;2;243;139;168mA1\x1b[39m");
	});
});
