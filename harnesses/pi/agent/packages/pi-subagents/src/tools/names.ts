export const AGENT_TOOLS = {
	spawnAgent: "spawn_agent",
	followupTask: "followup_task",
	sendMessage: "send_message",
	interruptAgent: "interrupt_agent",
	listAgents: "list_agents",
	waitAgent: "wait_agent",
} as const;

export const AGENT_TOOL_NAMES = Object.freeze(Object.values(AGENT_TOOLS));
