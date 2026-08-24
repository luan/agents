import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { BackgroundSurface } from "../src/background-surface.ts";
import { rgb } from "../src/color/palette.ts";
import { MarkdownText } from "../src/content/text.ts";
import { parseUnifiedDiff } from "../src/diff/index.ts";
import { RenderedLinesCache } from "../src/render-cache.ts";
import { type MeasuredTerminalColors, terminalColorsRegistry } from "../src/terminal-colors.ts";
import { ToolActivity } from "../src/tool/activity.ts";

const theme = { name: "harmonious", bold: (text: string) => text, getColorMode: () => "truecolor" } as Theme;

afterEach(() => {
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	terminalColorsRegistry().publish(undefined);
});

describe("shared render epoch", () => {
	test("invalidates rendered-line caches after an effective appearance change", () => {
		configureTuiAppearance({ iconPack: "unicode" });
		const cache = new RenderedLinesCache();
		let renders = 0;
		const first = cache.get(20, "stable", () => {
			renders += 1;
			return ["first"];
		});

		configureTuiAppearance({ iconPack: "emoji" });
		const second = cache.get(20, "stable", () => {
			renders += 1;
			return ["second"];
		});

		expect(renders).toBe(2);
		expect(second).not.toBe(first);
		expect(cache.get(20, "stable", () => ["third"])).toBe(second);
	});

	test("repaints a background surface after terminal colors change", () => {
		const registry = terminalColorsRegistry();
		registry.publish(terminalProfile(10));
		const surface = new BackgroundSurface({
			theme,
			component: staticComponent("same content"),
			background: "surface.inset",
		});

		const first = surface.render(40);
		registry.publish(terminalProfile(180));
		const second = surface.render(40);

		expect(second).not.toBe(first);
		expect(second).not.toEqual(first);
		registry.publish(terminalProfile(180));
		expect(surface.render(40)).toBe(second);
	});

	test("refreshes ToolActivity diff themes when terminal colors change", () => {
		const registry = terminalColorsRegistry();
		registry.publish(terminalProfile(10));
		const activity = new ToolActivity({
			theme,
			requestRender() {},
			view: {
				action: { verb: "edit", status: "succeeded" },
				payload: { kind: "diff", model: parseUnifiedDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new") },
			},
		});

		const firstLine = activity.render(60).find((line) => line.includes("new"));
		registry.publish(terminalProfile(180));
		const secondLine = activity.render(60).find((line) => line.includes("new"));

		expect(firstLine).toBeDefined();
		expect(secondLine).toBeDefined();
		expect(secondLine).not.toBe(firstLine);
		activity.dispose();
	});

	test("rerenders Markdown at the same width after the render epoch changes", () => {
		let marker = "first";
		const markdown = new MarkdownText({
			theme: {
				...theme,
				bold: (text: string) => `${marker}:${text}`,
			} as Theme,
			text: "**content**",
		});

		const first = markdown.render(40);
		marker = "second";
		terminalColorsRegistry().publish(terminalProfile(10));
		const second = markdown.render(40);

		expect(first.join("\n")).toContain("first:content");
		expect(second.join("\n")).toContain("second:content");
		expect(second).not.toBe(first);
	});
});

function staticComponent(text: string): Component {
	return {
		render: () => [text],
		invalidate() {},
	};
}

function terminalProfile(seed: number): MeasuredTerminalColors {
	const base16 = Array.from({ length: 16 }, (_, index) => rgb(seed + index, seed + index * 2, seed + index * 3));
	return {
		defaultBackground: base16[0],
		defaultForeground: base16[15],
		ansiBase16: base16,
		indexedPalette: "custom",
		scheme: "dark",
	};
}
