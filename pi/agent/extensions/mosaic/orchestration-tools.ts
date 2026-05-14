/** Tools that would let a subagent recursively orchestrate the parent workflow. */
import { MOSAIC_V2_TOOL_NAMES } from "./v2-tools.js";

export const MOSAIC_ORCHESTRATION_TOOL_NAMES = new Set<string>([
	...MOSAIC_V2_TOOL_NAMES,
	"spawn_lane",
	"spawn_list",
	"spawn_map",
	"skill",
]);

export function isMosaicOrchestrationToolName(toolName: string): boolean {
	return MOSAIC_ORCHESTRATION_TOOL_NAMES.has(toolName);
}
