import { expect, test } from "bun:test";
import subagentsExtension, {
	formatTaskResults,
	routeForegroundInput,
	shouldOwnAgentWidget,
	type TaskResult,
} from "./index";

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
	subagentsExtension({
		events: { on() {} },
		on() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as never);

	expect(tools).toEqual(["spawn_agent", "list_agents", "followup_task", "send_message", "stop_agent"]);
	expect(tools).not.toContain("task");
	expect(commands).toContain("subagents");
	expect(commands).toContain("subagent");
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
