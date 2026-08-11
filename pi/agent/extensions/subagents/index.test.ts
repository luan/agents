import { expect, test } from "bun:test";
import subagentsExtension, {
	attachAgentTerminal,
	formatTaskResults,
	mergeHubAgentRecords,
	normalizeItems,
	routeForegroundInput,
	shouldOwnAgentWidget,
	type TaskResult,
} from "./index";

test("spawn_agent accepts self-contained batch tasks without shared context", () => {
	expect(
		normalizeItems({
			agent: "explore",
			tasks: [{ id: "rmuxRootCause", assignment: "Find the root cause." }],
		}),
	).toEqual([{ id: "rmuxRootCause", assignment: "Find the root cause." }]);
});

test("returns complete subagent output to the parent", () => {
	const result: TaskResult = {
		index: 0,
		id: "agent-1",
		agent: "explore",
		description: "Research Chromium inbound sync",
		assignment: "Research the implementation.",
		status: "completed",
		output: "Finding one.\n\nFinding two with exact source paths.",
		durationMs: 1,
		toolUses: 0,
	};

	expect(formatTaskResults([result])).toBe(
		"## Research Chromium inbound sync (completed)\nFinding one.\n\nFinding two with exact source paths.",
	);
});

test("registers explicit agent tools instead of the generic task tool", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const shortcuts: string[] = [];
	subagentsExtension({
		events: { on() {} },
		on() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut(name: string) {
			shortcuts.push(name);
		},
	} as never);

	expect(tools).toEqual(["spawn_agent", "list_agents", "followup_task", "send_message", "stop_agent"]);
	expect(tools).not.toContain("task");
	expect(commands).toContain("hub");
	expect(shortcuts).toContain("alt+a");
	expect(commands).not.toContain("subagents");
	expect(commands).not.toContain("subagent");
});

test("spawn_agent keeps terminal placement internal", () => {
	let spawnTool: any;
	subagentsExtension({
		events: { on() {} },
		on() {},
		registerTool(tool: any) {
			if (tool.name === "spawn_agent") spawnTool = tool;
		},
		registerCommand() {},
	} as never);

	expect(spawnTool.parameters.properties.attach).toBeUndefined();
});

test("central Hub attachment hands the terminal to the agent process", async () => {
	const calls: string[] = [];
	const attached = await attachAgentTerminal(
		{
			attachment: {
				mode: "terminal",
				sessionName: "worker",
				socketPath: "/tmp/worker.sock",
				command: "true",
				args: [],
			},
		} as never,
		{
			terminal: { rows: 40, columns: 120 },
			stop: () => calls.push("stop"),
			start: () => calls.push("start"),
			requestRender: () => calls.push("render"),
		} as never,
	);

	expect(attached).toBe(true);
	expect(calls).toEqual(["stop", "start", "render"]);
});

test("Hub excludes agents from every other root session", () => {
	const saved = [
		{
			id: "old",
			rootSessionId: "old-root",
			status: "completed",
			startedAt: Date.now(),
			completedAt: Date.now(),
		},
		{
			id: "live",
			rootSessionId: "other-root",
			status: "running",
			executionMode: "attached",
			startedAt: Date.now(),
			attachment: { socketPath: "/tmp/live.sock" },
		},
	] as never[];
	const inMemory = [
		{
			id: "old-memory",
			rootSessionId: "old-root",
			status: "completed",
			startedAt: Date.now(),
		},
	] as never[];

	expect(mergeHubAgentRecords(saved, inMemory, "fresh-root").map((record) => record.id)).toEqual([]);
});

test("only the root session owns the agents widget", () => {
	const manager = {
		findByChildSessionId: (sessionId: string) => (sessionId === "child-session" ? { id: "parent" } : undefined),
	};

	expect(shouldOwnAgentWidget(manager as never, "root-session", true)).toBe(true);
	expect(shouldOwnAgentWidget(manager as never, "child-session", true)).toBe(false);
	expect(shouldOwnAgentWidget(manager as never, "root-session", false)).toBe(false);
});

test("backgrounds a blocking foreground subagent and keeps input in the main session", () => {
	const backgrounded: string[] = [];
	const manager = {
		listAgents: () => [
			{
				id: "worker",
				parentSessionId: "main-session",
				status: "running",
				isBackground: false,
			},
		],
		background: (id: string) => {
			backgrounded.push(id);
			return true;
		},
	};

	expect(
		routeForegroundInput(manager as never, "main-session", {
			source: "interactive",
			streamingBehavior: "steer",
		}),
	).toEqual({ action: "continue", backgrounded: 1 });
	expect(backgrounded).toEqual(["worker"]);
});
