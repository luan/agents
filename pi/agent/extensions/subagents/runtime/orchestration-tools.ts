/** Parent-owned interaction/state tools that delegated agents must not use. */
const NAMES = new Set<string>(["ask_user", "task_write"]);

export function isSubagentOrchestrationToolName(toolName: string): boolean {
	return NAMES.has(toolName);
}
