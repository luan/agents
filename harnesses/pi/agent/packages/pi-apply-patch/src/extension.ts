import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchCodeModeAdapter } from "./code-mode-adapter.ts";
import {
	createApplyPatchTool,
	registerApplyPatchResultEvent,
	registerApplyPatchTool,
} from "./tools/apply-patch/definition.ts";

export default function applyPatchExtension(pi: ExtensionAPI): void {
	const tool = createApplyPatchTool();
	registerApplyPatchTool(pi, tool);
	registerApplyPatchResultEvent(pi);
	const disposeCodeModeAdapter = registerApplyPatchCodeModeAdapter(tool);
	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload" || event.reason === "quit") {
			disposeCodeModeAdapter();
		}
	});
}
