import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget, renderMosaicHudIdentityPrefix, type Theme } from "./agent-widget";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const originalDateNow = Date.now;

afterEach(() => {
	Date.now = originalDateNow;
});

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

		expect(rendered).toContain("\x1b[38;2;243;139;168m●\x1b[39m");
		expect(rendered).toContain("\x1b[38;2;243;139;168mA1\x1b[39m");
	});

	test("cycles the mosaic identity dot glyph while pulsing brightness", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};

		const dim = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 0);
		const bright = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 13);
		const cycle = Array.from({ length: 6 }, (_, frame) =>
			stripAnsi(renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, frame)).slice(0, 1),
		);

		expect(dim).toContain("\x1b[38;2;109;63;76m•\x1b[39m");
		expect(bright).toContain("\x1b[38;2;255;169;205m·\x1b[39m");
		expect(cycle).toEqual(["•", "·", "∙", "●", "○", "◦"]);
		expect(stripAnsi(dim)).toBe("• A1 ");
		expect(stripAnsi(bright)).toBe("· A1 ");
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

		expect(completed).toStartWith("└─ ● A1 Agent");
		expect(completed).not.toStartWith("└─ ✓");
		expect(completed.endsWith("✓")).toBe(true);
		expect(visibleWidth(lines[1] ?? "")).toBe(60);
	});

	test("uses the mosaic dot cycle for running agent motion", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		Date.now = () => now;
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "general-purpose",
				description: "Running agent",
				status: "running",
				toolUses: 0,
				startedAt: now - 1000,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
				mosaicIdentity: { label: "A1", color: "f38ba8" },
			},
		]);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 80 } },
			theme,
		);
		const rendered = stripAnsi(lines.join("\n"));

		expect(rendered).toContain("• A1 Agent");
	});

	test("keeps completed mosaic agents visible until they are explicitly closed", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "general-purpose",
				description: "Fast ready agent",
				status: "completed",
				toolUses: 0,
				startedAt: now - 1000,
				completedAt: now,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
				mosaicIdentity: { label: "A1", color: "f38ba8" },
			},
		]);

		for (let i = 0; i < 10; i++) widget.onTurnStart();
		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 60 } },
			theme,
		);

		expect(stripAnsi(lines.join("\n"))).toContain("Fast ready agent");
	});

	test("expires stopped mosaic agents by wall clock when their pane exits", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = 10_000;
		Date.now = () => now;
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "general-purpose",
				description: "Exited agent",
				status: "stopped",
				toolUses: 0,
				startedAt: now - 10_000,
				completedAt: now - 6000,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
				mosaicIdentity: { label: "A1", color: "f38ba8" },
			},
		]);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 60 } },
			theme,
		);

		expect(lines).toEqual([]);
	});
});
