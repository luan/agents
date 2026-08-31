import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, tuiTheme } from "pi-libtui";
import { TuiState } from "../src/runtime/state.ts";
import { contextStatus, workingStatus } from "../src/ui/footer.ts";

const theme = {
	name: "custom-editor-footer-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => {
		if (token === "success") return "\x1b[38;2;40;210;100m";
		if (token === "warning") return "\x1b[38;2;240;190;60m";
		if (token === "error") return "\x1b[38;2;240;70;70m";
		if (token === "accent") return "\x1b[38;2;80;150;240m";
		if (token === "text") return "\x1b[38;2;235;235;235m";
		return "\x1b[38;2;120;130;145m";
	},
	getBgAnsi: () => "\x1b[48;2;24;28;36m",
} as never as Theme;

describe("custom editor footer", () => {
	test("keeps low nonzero context usage visibly colored by its window preset", () => {
		const ctx = {
			getContextUsage: () => ({ tokens: 8_000, contextWindow: 272_000, percent: 2.8 }),
		} as never as ExtensionContext;
		const preset = tuiTheme(theme).fg({ hue: "cyan", shade: 3 }, "Balanced (272k)");
		const rendered = contextStatus(ctx, { input: 0, output: 0, cost: 0 }, theme, 48, preset);

		expect(stripTerminalSequences(rendered)).toContain("ctx ━");
		expect(rendered).toContain(tuiTheme(theme).fgAnsi({ hue: "cyan", shade: 3 }));
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(48);
	});

	test("uses one preset color for the gauge, metrics, and qualifier", () => {
		const ctx = {
			getContextUsage: () => ({ tokens: 80_000, contextWindow: 400_000, percent: 20 }),
		} as never as ExtensionContext;
		const colors = tuiTheme(theme);
		const presetColor = { hue: "blue", shade: 4 } as const;
		const rendered = contextStatus(
			ctx,
			{ input: 0, output: 0, cost: 0 },
			theme,
			64,
			colors.fg(presetColor, "Enhanced (400k)"),
		);

		expect(stripTerminalSequences(rendered)).toContain("20.0% 80k/400k (enhanced)");
		expect(rendered).toContain(`${colors.fgAnsi(presetColor)}━━━━`);
		expect(rendered).toContain(colors.fg(presetColor, "20.0% 80k/400k"));
		expect(rendered).toContain(colors.fg(presetColor, "(enhanced)"));
	});

	test("renders the configured working indicator and fast label", () => {
		configureTuiAppearance({ ...DEFAULT_TUI_APPEARANCE, workingIndicator: "spinner" });
		const state = new TuiState();
		state.fastMode = true;
		state.start(Date.now());
		const rendered = stripTerminalSequences(workingStatus(state, theme, 48));

		expect(rendered).toContain("Zipping");
		expect(rendered).not.toStartWith("Zipping");
	});
});
