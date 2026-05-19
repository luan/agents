/** Tools that would let a subagent recursively orchestrate the parent workflow. */
import { MOSAIC_TOOL_NAMES } from "./tools.js";

export const MOSAIC_ORCHESTRATION_TOOL_NAMES = new Set<string>(MOSAIC_TOOL_NAMES);

export function isMosaicOrchestrationToolName(toolName: string): boolean {
	return MOSAIC_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
