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

	test("uses highlight trickle instead of cycling the mosaic identity glyph", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};

		const dim = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 0);
		const bright = renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, 13);
		const cycle = Array.from({ length: 6 }, (_, frame) =>
			stripAnsi(renderMosaicHudIdentityPrefix({ label: "A1", color: "f38ba8" }, theme, frame)).slice(0, 1),
		);

		expect(dim).toContain("●");
		expect(bright).toContain("●");
		expect(cycle).toEqual(["●", "●", "●", "●", "●", "●"]);
		expect(stripAnsi(dim)).toBe("● A1 ");
		expect(stripAnsi(bright)).toBe("● A1 ");
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

	test("uses highlight trickle for running agent motion", () => {
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

		expect(rendered).toContain("● A1 Agent");
	});

	test("does not render inline in-process agents in the HUD", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		const widget = new AgentWidget(
			{
				listAgents: () => [
					{
						id: "inline-1",
						type: "general-purpose",
						description: "Inline probe",
						status: "running",
						isBackground: false,
						toolUses: 0,
						startedAt: now,
						lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
						compactionCount: 0,
					},
				],
			} as never,
			new Map(),
		);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 60 } },
			theme,
		);

		expect(lines).toEqual([]);
	});

	test("renders background in-process agents in the HUD", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		const widget = new AgentWidget(
			{
				listAgents: () => [
					{
						id: "bg-1",
						type: "general-purpose",
						description: "Background probe",
						status: "running",
						isBackground: true,
						toolUses: 0,
						startedAt: now,
						lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
						compactionCount: 0,
					},
				],
			} as never,
			new Map(),
		);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 80 } },
			theme,
		);

		expect(stripAnsi(lines.join("\n"))).toContain("Background probe");
	});

	test("renders model and effort metadata in the HUD", () => {
		const theme: Theme = {
			fg: (_color, text) => text,
			bold: (text) => text,
		};
		const now = Date.now();
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "Explore",
				description: "Inspect scope",
				status: "running",
				toolUses: 0,
				startedAt: now,
				modelName: "claude-haiku-4-5",
				thinkingLevel: "high",
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
			},
		]);

		const lines = (widget as unknown as { renderWidget(tui: unknown, theme: Theme): string[] }).renderWidget(
			{ terminal: { columns: 100 } },
			theme,
		);

		expect(stripAnsi(lines.join("\n"))).toContain("claude-haiku-4-5 · effort high");
	});

	test("expires completed mosaic agents by wall clock so idle HUD timers stop", () => {
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
				description: "Fast ready agent",
				status: "completed",
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

	test("stops the HUD timer when no active agents remain", () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const intervals: Array<() => void> = [];
		const cleared: unknown[] = [];
		(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((fn: () => void) => {
			intervals.push(fn);
			return { fake: intervals.length } as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;
		(globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((handle: unknown) => {
			cleared.push(handle);
		}) as typeof clearInterval;
		try {
			let status = "running";
			const now = 10_000;
			Date.now = () => now;
			const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
				{
					id: "a1",
					type: "general-purpose",
					description: "Fast ready agent",
					status,
					toolUses: 0,
					startedAt: now - 10_000,
					completedAt: status === "running" ? undefined : now - 6000,
					lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
					compactionCount: 0,
					mosaicIdentity: { label: "A1", color: "f38ba8" },
				},
			]);
			widget.setUICtx({
				setWidget() {},
				setStatus() {},
			});

			widget.update();
			expect(intervals).toHaveLength(1);

			status = "completed";
			widget.update();
			expect(cleared).toHaveLength(1);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	test("does not register the HUD for finished-only agents", () => {
		const calls: Array<{ key: string; content: unknown }> = [];
		const now = 10_000;
		Date.now = () => now;
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map(), () => [
			{
				id: "a1",
				type: "general-purpose",
				description: "Already done",
				status: "completed",
				toolUses: 0,
				startedAt: now - 10_000,
				completedAt: now,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				compactionCount: 0,
				mosaicIdentity: { label: "A1", color: "f38ba8" },
			},
		]);
		widget.setUICtx({
			setWidget(key, content) {
				calls.push({ key, content });
			},
			setStatus() {},
		});

		widget.update();

		expect(calls).toEqual([]);
	});

	test("dispose is a no-op before widget or status registration", () => {
		const calls: Array<{ key: string; content: unknown }> = [];
		const widget = new AgentWidget({ listAgents: () => [] } as never, new Map());
		widget.setUICtx({
			setWidget(key, content) {
				calls.push({ key, content });
			},
			setStatus(key, content) {
				calls.push({ key, content });
			},
		});

		widget.dispose();

		expect(calls).toEqual([]);
	});
});
