// Bare, because codex calls tools bare in a cell; `collaboration.spawn_agent` would 400 on the 23 `anthropic-messages` models in models-store.json, since pi-ai passes names through unvalidated (api/anthropic-messages.js:995).
export const AGENT_TOOLS = {
	spawnAgent: "spawn_agent",
	followupTask: "followup_task",
	sendMessage: "send_message",
	interruptAgent: "interrupt_agent",
	listAgents: "list_agents",
	waitAgent: "wait_agent",
} as const;

export const AGENT_TOOL_NAMES: readonly string[] = Object.freeze(Object.values(AGENT_TOOLS));
