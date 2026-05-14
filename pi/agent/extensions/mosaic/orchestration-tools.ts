/** Tools that would let a subagent recursively orchestrate the parent workflow. */
export const MOSAIC_ORCHESTRATION_TOOL_NAMES = new Set(["Agent", "get_subagent_result", "steer_subagent", "skill"]);

export function isMosaicOrchestrationToolName(toolName: string): boolean {
	return MOSAIC_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
