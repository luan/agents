import { registerCodeModeFunctionTool } from "pi-code-mode/sdk";
import type { createSkillTool } from "./tools/skill/definition.ts";

export function registerSkillCodeModeAdapter(tool: ReturnType<typeof createSkillTool>): () => void {
	return registerCodeModeFunctionTool(tool);
}
