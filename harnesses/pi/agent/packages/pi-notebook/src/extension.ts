import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";
import { NotebookClient } from "./runtime/client.ts";
import { notebookTools, notebookResult } from "./tools/definition.ts";
export default function notebookExtension(pi: ExtensionAPI): void {
	const client = new NotebookClient();
	const tools = notebookTools(client);
	pi.registerTool(tools.execute);
	pi.registerTool(tools.control);
	const disposers = [
		registerCodeModeFunctionTool(tools.execute, { resultValue: notebookResult }),
		registerCodeModeFunctionTool(tools.control, { resultValue: notebookResult }),
	];
	pi.on("session_start", () => client.stop());
	pi.on("session_shutdown", () => {
		client.stop();
		for (const dispose of disposers) dispose();
	});
}
