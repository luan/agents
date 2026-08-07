import { afterEach, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setSharedAnimationRenderGuard } from "../../../shared/tui";
import { AgentWidget, formatAgentModelInfo } from "./agent-widget";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

afterEach(() => setSharedAnimationRenderGuard(undefined));

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
		fastModeActive: index === 0,
		assignment: "work",
		cwd: "/tmp",
		events: [],
		toolUses: 0,
		startedAt: 1000,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0.42 },
		compactionCount: 0,
	}));
	const activity = new Map([
		[
			"/root/parent",
			{
				activeTools: new Map(),
				toolUses: 0,
				responseText: "",
				turnCount: 0,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0.42 },
			},
		],
	]);
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		activity,
		() => records as never,
		() => "root-session",
	);
	const renderWidget = (
		widget as unknown as { renderWidget(theme: typeof theme, width: number, now: number): string[] }
	).renderWidget.bind(widget, theme, 120);
	const lines = renderWidget(1000);
	const nextFrame = renderWidget(1120);

	expect(lines).toHaveLength(3);
	expect(lines[0]).toContain("2 running");
	expect(lines.some((line) => line.includes("/root/"))).toBe(false);
	expect(lines[1]).toContain("parent");
	expect(lines[2]).toContain("parent/reviewer");
	expect(lines[1]).toContain("GPT-5.6 Luna");
	expect(lines[1]).toContain("effort medium");
	expect(lines[1]).toContain("$0.42");
	expect(lines[1]).toContain("⚡ fast");
	expect(lines[1]).toEndWith("| thinking");
	expect(nextFrame[1]).not.toBe(lines[1]);
});

test("removes the above-editor widget when the last agent completes", () => {
	const records = [
		{
			id: "worker",
			type: "task",
			description: "worker",
			status: "running",
			rootSessionId: "root-session",
			parentSessionId: "root-session",
			assignment: "work",
			cwd: "/tmp",
			events: [],
			toolUses: 0,
			startedAt: 1000,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		},
	];
	const widgetCalls: Array<unknown> = [];
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		new Map(),
		() => records as never,
		() => "root-session",
	);
	widget.setUICtx({
		setStatus: () => {},
		setWidget: (_key, content) => widgetCalls.push(content),
	});

	widget.update();
	expect(widgetCalls.at(-1)).toBeFunction();
	records[0]!.status = "completed";
	widget.update();
	expect(widgetCalls.at(-1)).toBeUndefined();
	widget.dispose();
});

test("moves animation to a replacement UI context", async () => {
	const records = [
		{
			id: "worker",
			type: "task",
			description: "worker",
			status: "running",
			rootSessionId: "root-session",
			parentSessionId: "root-session",
			assignment: "work",
			cwd: "/tmp",
			events: [],
			toolUses: 0,
			startedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		},
	];
	const renders = [0, 0];
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		new Map(),
		() => records as never,
		() => "root-session",
	);
	const context = (index: number) => ({
		setStatus() {},
		setWidget: (_key: string, content: unknown) => {
			if (typeof content === "function") {
				content({ requestRender: () => renders[index]++ }, theme);
			}
		},
	});

	widget.setUICtx(context(0));
	widget.update();
	await Bun.sleep(140);
	expect(renders).toEqual([1, 0]);

	widget.setUICtx(context(1));
	widget.update();
	await Bun.sleep(140);
	expect(renders).toEqual([1, 1]);
	widget.dispose();
});

test("animates independently but pauses repaint while the editor is active", async () => {
	const records = ["one", "two", "three"].map((id) => ({
		id,
		type: "explore",
		description: id,
		status: "running",
		rootSessionId: "root-session",
		parentSessionId: "root-session",
		assignment: "audit",
		cwd: "/tmp",
		events: [],
		toolUses: 0,
		startedAt: Date.now(),
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	}));
	let renders = 0;
	let editorActive = true;
	setSharedAnimationRenderGuard(() => !editorActive);
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		new Map(),
		() => records as never,
		() => "root-session",
	);
	widget.setUICtx({
		setStatus: () => {},
		setWidget: (_key, content) => {
			if (typeof content === "function") {
				content({ terminal: { columns: 120 }, requestRender: () => renders++ }, theme);
			}
		},
	});

	widget.update();
	await Bun.sleep(140);
	expect(renders).toBe(0);
	editorActive = false;
	await Bun.sleep(140);
	expect(renders).toBe(1);
	widget.dispose();
	await Bun.sleep(140);
	expect(renders).toBe(1);
});

test("bounds the sticky widget to Pi's assigned dock width", () => {
	const records = [
		{
			id: "agent-with-a-long-identifier",
			type: "explore",
			description: "agent",
			status: "running",
			rootSessionId: "root-session",
			parentSessionId: "root-session",
			assignment: "audit",
			cwd: "/tmp",
			events: [],
			toolUses: 0,
			startedAt: Date.now(),
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
			compactionCount: 0,
		},
	];
	let component: { render(width: number): string[] } | undefined;
	const widget = new AgentWidget(
		{ listAgents: () => [] } as never,
		new Map(),
		() => records as never,
		() => "root-session",
	);
	widget.setUICtx({
		setStatus: () => {},
		setWidget: (_key, content) => {
			if (typeof content === "function") {
				component = content({ terminal: { columns: 120 }, requestRender() {} }, theme);
			}
		},
	});

	widget.update();
	expect(component?.render(32).every((line) => visibleWidth(line) <= 32)).toBe(true);
	widget.dispose();
});
