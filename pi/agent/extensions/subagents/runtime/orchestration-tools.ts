/** Parent-owned interaction/state tools that delegated agents must not use. */
export const SUBAGENT_ORCHESTRATION_TOOL_NAMES = new Set<string>(["ask_user", "task_write"]);

export function isSubagentOrchestrationToolName(toolName: string): boolean {
	return SUBAGENT_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
