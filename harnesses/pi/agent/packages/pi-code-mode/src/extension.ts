import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeModeRuntime } from "./runtime/code-mode.ts";
import { registerCodeModeLifecycle } from "./runtime/lifecycle.ts";
import { createExecTool } from "./tools/exec/definition.ts";
import { createWaitTool } from "./tools/wait/definition.ts";
import {
	createCodeModeSettings,
	DEFAULT_CODE_MODE_SETTINGS,
	type CodeModeSettings,
} from "./contributions/xsettings.ts";

export default function codeModeExtension(pi: ExtensionAPI): void {
	const runtime = new CodeModeRuntime(pi);
	let settings = { ...DEFAULT_CODE_MODE_SETTINGS };
	let execTool = createExecTool(runtime, settings);
	let waitTool = createWaitTool(runtime, settings);
	pi.registerTool(execTool);
	pi.registerTool(waitTool);
	const applySettings = (next: CodeModeSettings): void => {
		if (sameSettings(settings, next)) return;
		settings = { ...next };
		execTool = createExecTool(runtime, settings);
		waitTool = createWaitTool(runtime, settings);
		pi.registerTool(execTool);
		pi.registerTool(waitTool);
	};
	let settingsClient = createCodeModeSettings();
	let unregisterXSettings = settingsClient.register(applySettings);
	pi.on("session_start", () => {
		runtime.claimAdapters();
		unregisterXSettings();
		settingsClient = createCodeModeSettings(runtime.availableTools());
		unregisterXSettings = settingsClient.register(applySettings);
	});
	registerCodeModeLifecycle(
		pi,
		runtime,
		() => ({ settings, execTool, waitTool }),
		(reason) => {
			if (reason === "reload" || reason === "quit") unregisterXSettings();
		},
	);
}

function sameSettings(left: CodeModeSettings, right: CodeModeSettings): boolean {
	return (
		left.enabled === right.enabled &&
		left.tools.length === right.tools.length &&
		left.tools.every((tool, index) => tool === right.tools[index]) &&
		left.defaultOutputTokens === right.defaultOutputTokens &&
		left.defaultExecYieldMs === right.defaultExecYieldMs &&
		left.defaultWaitYieldMs === right.defaultWaitYieldMs
	);
}
