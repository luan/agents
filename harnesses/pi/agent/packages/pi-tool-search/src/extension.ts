import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolSearchCodeModeAdapter } from "./code-mode-adapter.ts";
import { createToolSearchSettings, type ToolSearchSettings } from "./contributions/xsettings.ts";
import { createToolSearchTool } from "./tools/tool-search/definition.ts";

export default function toolSearchExtension(pi: ExtensionAPI): void {
	let directTools: ReturnType<ExtensionAPI["getAllTools"]> = [];
	const directScope = {
		tools: () => directTools,
		active: () => {
			const assigned = new Set(directTools.map((candidate) => candidate.name));
			return pi.getActiveTools().filter((name) => assigned.has(name));
		},
		setActive: (names: readonly string[]) => {
			const assigned = new Set(directTools.map((candidate) => candidate.name));
			pi.setActiveTools([...pi.getActiveTools().filter((name) => !assigned.has(name)), ...names]);
		},
	};
	const tool = createToolSearchTool(directScope);
	pi.registerTool(tool);
	const codeMode = registerToolSearchCodeModeAdapter(tool);
	let deferredTools: string[] = [];
	let settingsClient = createToolSearchSettings();
	let unregisterXSettings = settingsClient.register((settings) => {
		deferredTools = [...settings.tools];
	});
	pi.on("session_start", () => {
		const nestedScope = codeMode.scope();
		const activeTools = pi.getActiveTools();
		const active = new Set(activeTools);
		directTools = pi.getAllTools().filter((candidate) => candidate.name !== tool.name && active.has(candidate.name));
		const assignedTools = nestedScope?.tools() ?? directTools;
		const options = assignedTools
			.map((candidate) => ({ name: candidate.name, description: candidate.description }))
			.sort((left, right) => left.name.localeCompare(right.name));
		unregisterXSettings();
		settingsClient = createToolSearchSettings(options);
		unregisterXSettings = settingsClient.register((settings: ToolSearchSettings) => {
			deferredTools = [...settings.tools];
		});
		const deferred = new Set(deferredTools);
		const scope = nestedScope ?? directScope;
		scope.setActive(
			scope
				.tools()
				.map((candidate) => candidate.name)
				.filter((name) => !deferred.has(name)),
		);
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload" && event.reason !== "quit") return;
		unregisterXSettings();
		codeMode.dispose();
	});
}
