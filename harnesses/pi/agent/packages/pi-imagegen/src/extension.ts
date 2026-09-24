import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";
import { createImagegenTool, imagegenResult } from "./tools/imagegen/definition.ts";
export default function imagegenExtension(pi: ExtensionAPI): void {
	const tool = createImagegenTool();
	pi.registerTool(tool);
	const dispose = registerCodeModeFunctionTool(tool, { resultValue: imagegenResult });
	pi.on("session_shutdown", () => dispose());
}
