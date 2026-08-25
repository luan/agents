import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COLOR256_PREVIEW_WIDTH, renderColor256Preview } from "../src/color/preview.ts";

describe("color256 preview", () => {
	test("matches the upstream terminal grid dimensions and labels", () => {
		const lines = renderColor256Preview("harmonious");
		expect(lines).toHaveLength(20);
		expect(lines.every((line) => visibleWidth(line) === COLOR256_PREVIEW_WIDTH)).toBe(true);
		expect(stripAnsi(lines.at(-1)!)).toContain("harmonious");
	});

	test("renders the active 256-color indexes instead of a second RGB palette", () => {
		const output = renderColor256Preview("harmonious").join("\n");
		expect(output).toContain("\x1b[38;5;231;7m");
		expect(output).toContain("\x1b[48;5;52m");
		expect(output).toContain("\x1b[38;5;15;7m");
	});
});

function stripAnsi(value: string): string {
	return value.replaceAll(/\x1b\[[0-9;]*m/gu, "");
}
