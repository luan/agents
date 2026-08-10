import { expect, test } from "bun:test";
import { AgentWidget } from "./agent-widget";

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
