import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodeModeSettings } from "../contributions/xsettings.ts";
import type { createExecTool } from "../tools/exec/definition.ts";
import { buildExecDescription } from "../tools/exec/definition.ts";
import type { createWaitTool } from "../tools/wait/definition.ts";
import type { CodeModeRuntime } from "./code-mode.ts";

type ExecTool = ReturnType<typeof createExecTool>;
type WaitTool = ReturnType<typeof createWaitTool>;

export function registerCodeModeLifecycle(
	pi: ExtensionAPI,
	runtime: CodeModeRuntime,
	current: () => { settings: CodeModeSettings; execTool: ExecTool; waitTool: WaitTool },
	dispose?: (reason: string) => void,
): void {
	const refreshDescription = (provider: string | undefined): void => {
		const { settings, execTool } = current();
		execTool.description = buildExecDescription(runtime.collectAdapters(), {
			...settings,
			supportsAudio: provider === "openai-codex",
		});
	};
	pi.on("session_start", (_event, ctx) => {
		runtime.claimAdapters();
		const { settings, execTool, waitTool } = current();
		const initialActiveTools = pi.getActiveTools();
		const activeBeforeLift = [...new Set([...initialActiveTools, ...runtime.liftedTools()])];
		const execWasActive = initialActiveTools.includes("exec");
		const configured = new Set(settings.tools);
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const adapters = new Map(runtime.scopedAdapters().map((adapter) => [adapter.name, adapter]));
		const lifted =
			settings.enabled && execWasActive
				? activeBeforeLift.filter((name) => configured.has(name) && registered.has(name) && adapters.has(name))
				: [];
		const liftedNames = new Set(lifted);
		runtime.setLiftedTools(lifted);
		refreshDescription(ctx.model?.provider);
		for (const adapter of adapters.values()) adapter.onScopeChange?.(undefined);
		for (const name of lifted) {
			const owner = adapters.get(name);
			if (!owner?.onScopeChange) continue;
			const assigned = lifted.filter((candidate) => candidate !== name);
			const assignedSet = new Set(assigned);
			owner.onScopeChange({
				tools: () =>
					assigned.flatMap((candidate) => {
						const tool = pi.getAllTools().find((entry) => entry.name === candidate);
						return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
					}),
				active: () => runtime.liftedTools().filter((candidate) => assignedSet.has(candidate)),
				setActive: (names) => {
					const requested = new Set(names.filter((candidate) => assignedSet.has(candidate)));
					runtime.setLiftedTools(lifted.filter((candidate) => candidate === name || requested.has(candidate)));
					refreshDescription(ctx.model?.provider);
				},
			});
		}
		pi.registerTool(execTool);
		pi.registerTool(waitTool);
		if (!settings.enabled) {
			pi.setActiveTools(activeBeforeLift.filter((name) => name !== "exec" && name !== "wait"));
			return;
		}
		if (!execWasActive) {
			pi.setActiveTools(activeBeforeLift.filter((name) => name !== "wait"));
			return;
		}
		pi.setActiveTools(activeBeforeLift.filter((name) => !liftedNames.has(name)));
	});
	pi.on("model_select", (event) => refreshDescription(event.model.provider));

	pi.on("tool_result", (event) => {
		if (event.toolName !== "exec" && event.toolName !== "wait") return undefined;
		const details = event.details as { codeMode?: boolean; isError?: boolean } | undefined;
		return details?.codeMode && details.isError ? { isError: true } : undefined;
	});

	pi.on("session_tree", async () => runtime.shutdown());
	pi.on("session_shutdown", async (event) => {
		for (const adapter of runtime.scopedAdapters()) adapter.onScopeChange?.(undefined);
		dispose?.(event.reason);
		await runtime.shutdown();
	});
}
