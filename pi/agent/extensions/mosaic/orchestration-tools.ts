/** Tools children must not use because they recurse into orchestration or mutate parent-owned state. */
import { MOSAIC_TOOL_NAMES } from "./tools.js";

export const MOSAIC_ORCHESTRATION_TOOL_NAMES = new Set<string>([
	...MOSAIC_TOOL_NAMES,
	"task",
	"subagent_list",
	"subagent_send",
	"ask_user",
	"task_write",
]);

export function isMosaicOrchestrationToolName(toolName: string): boolean {
	return MOSAIC_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
