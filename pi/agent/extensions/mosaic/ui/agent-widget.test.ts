import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget, renderMosaicHudIdentityPrefix, type Theme } from "./agent-widget";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

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

	test("pulses the mosaic rail glyph with the editor rail timing", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};

		const dim = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 0);
		const bright = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 13);

		expect(dim).toContain("\x1b[48;2;44;25;30m");
		expect(bright).toContain("\x1b[48;2;255;168;203m");
		expect(stripAnsi(dim)).toBe("▐▌ A1 ");
		expect(stripAnsi(bright)).toBe("▐▌ A1 ");
		expect(dim).not.toBe(bright);
	});

	test("renders completed status at the right edge instead of before the identity", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "general-purpose",
				description: "Demo researcher",
				status: "completed",
				toolUses: 0,
				startedAt: now - 1000,
				completedAt: now,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
				mosaicIdentity: { label: "A1", color: "f38ba8" },
			},
		]);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 60 } },
			theme,
		);
		const completed = stripAnsi(lines[1] ?? "");

		expect(completed).toStartWith("└─ ▐▌ A1 Agent");
		expect(completed).not.toStartWith("└─ ✓");
		expect(completed.endsWith("✓")).toBe(true);
		expect(visibleWidth(lines[1] ?? "")).toBe(60);
	});
});
