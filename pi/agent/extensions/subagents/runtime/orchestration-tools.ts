/** Tools children must not use because they recurse into orchestration or mutate parent-owned state. */
export const SUBAGENT_ORCHESTRATION_TOOL_NAMES = new Set<string>([
	"task",
	"subagent_list",
	"subagent_send",
	"ask_user",
	"task_write",
]);

export function isSubagentOrchestrationToolName(toolName: string): boolean {
	return SUBAGENT_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
