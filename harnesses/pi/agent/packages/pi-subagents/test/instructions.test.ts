import { expect, test } from "bun:test";
import {
	DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT,
	DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT,
	EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT,
	multiAgentModeInstructions,
	multiAgentRoleInstructions,
	PROACTIVE_MULTI_AGENT_MODE_TEXT,
} from "../src/core/instructions.ts";

test("keeps Codex's root usage hint exact", () => {
	expect(
		DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT,
	).toBe(`You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
They may be addressed as to=/root
`);
});

test("keeps Codex's subagent usage hint exact", () => {
	expect(
		DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT,
	).toBe(`You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a response in the final channel, that content is immediately delivered back to your parent agent.

You will receive messages in the analysis channel in the form:
\`\`\`
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>
\`\`\`
You may also see them addressed as to=/root/..., which indicates your identity is /root/...
`);
});

test("keeps Codex's built-in delegation policies exact", () => {
	expect(EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT).toBe(
		"Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.",
	);
	expect(PROACTIVE_MULTI_AGENT_MODE_TEXT).toBe(
		"Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.",
	);
});

test("renders the ordered policy spectrum as a dedicated developer fragment", () => {
	for (const mode of [
		"direct-requests-only",
		"explicit-requests",
		"proactive-read-only",
		"proactive-mechanical",
		"proactive",
	] as const) {
		expect(multiAgentModeInstructions(mode)).toMatch(/^<multi_agent_mode>.+<\/multi_agent_mode>$/s);
	}
	expect(multiAgentModeInstructions("direct-requests-only")).toContain(
		"AGENTS.md and skill instructions do not authorize spawning",
	);
	expect(multiAgentModeInstructions("proactive-read-only")).toContain("Do not delegate edits");
	expect(multiAgentModeInstructions("proactive-mechanical")).toContain("mechanical edits");
});

test("selects the exact Codex role and appends runtime limits", () => {
	expect(multiAgentRoleInstructions("/root", 8)).toStartWith(DEFAULT_MULTI_AGENT_V2_ROOT_AGENT_USAGE_HINT_TEXT);
	expect(multiAgentRoleInstructions("/root/review", 8)).toStartWith(DEFAULT_MULTI_AGENT_V2_SUBAGENT_USAGE_HINT_TEXT);
	expect(multiAgentRoleInstructions("/root/review", 8)).toContain("8 available concurrency slots");
});
