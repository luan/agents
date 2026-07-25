import { expect, test } from "bun:test";
import { AgentWidget, formatAgentModelInfo, WIDGET_REFRESH_MS } from "./agent-widget";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("shows the subagent model and thinking effort", () => {
	expect(formatAgentModelInfo({ modelName: "GPT-5.6 Luna", thinkingLevel: "medium" }, theme)).toBe(
		"GPT-5.6 Luna | effort medium",
	);
});

test("uses a calm refresh rate and one HUD row per running agent", () => {
	const records = ["parent", "parent/reviewer"].map((suffix, index) => ({
		id: `/root/${suffix}`,
		type: "task",
		description: suffix,
		status: "running",
		rootSessionId: "root-session",
		parentSessionId: index === 0 ? "root-session" : "child-session",
		parentAgentId: index === 0 ? undefined : "/root/parent",
		modelName: "GPT-5.6 Luna",
		thinkingLevel: "medium",
		assignment: "work",
		cwd: "/tmp",
		events: [],
		toolUses: 0,
		startedAt: 1000,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0.42 },
		compactionCount: 0,
	}));
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		new Map(),
		() => records as never,
		() => "root-session",
	);
	const renderWidget = (
		widget as unknown as { renderWidget(tui: unknown, theme: typeof theme, now: number): string[] }
	).renderWidget.bind(widget, { terminal: { columns: 120 } }, theme);
	const lines = renderWidget(1000);
	const nextFrame = renderWidget(1120);

	expect(WIDGET_REFRESH_MS).toBeLessThanOrEqual(150);
	expect(lines).toHaveLength(3);
	expect(lines[0]).toContain("2 running");
	expect(lines.some((line) => line.includes("/root/"))).toBe(false);
	expect(lines[1]).toContain("parent");
	expect(lines[2]).toContain("parent/reviewer");
	expect(lines[1]).toContain("GPT-5.6 Luna");
	expect(lines[1]).toContain("effort medium");
	expect(lines[1]).toContain("$0.42");
	expect(lines[1]).toEndWith("| thinking");
	expect(nextFrame[1]).not.toBe(lines[1]);
});
