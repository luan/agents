import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listCodeModeToolNames, registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";
import { getCodexNativeSettings } from "../../contributions/xsettings.ts";
import { reasoningPresentation } from "./presentation.ts";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;
const levels: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const parameters = Type.Object({ level: StringEnum(["low", "medium", "high"] as const) });
export interface ReasoningDetails {
	version: 1;
	tool: "change_reasoning";
	status: "completed";
	level: Level;
	floor: Level;
}
export function autoReasoningAvailable(ctx: ExtensionContext): boolean {
	const settings = getCodexNativeSettings(ctx.sessionManager.getSessionId());
	return (
		settings.autoReasoning &&
		settings.reasoningMode === "pi" &&
		ctx.model?.provider === "openai-codex" &&
		ctx.model.api === "openai-codex-responses" &&
		ctx.model.id === "gpt-6-astra"
	);
}
export function registerAutoReasoning(pi: ExtensionAPI): () => void {
	let activeContext: ExtensionContext | undefined;
	let baseline: { level: Level; model: string; session: string } | undefined;
	let applied: Level | undefined;
	const matches = (ctx: ExtensionContext) =>
		baseline?.model === ctx.model?.id && baseline?.session === ctx.sessionManager.getSessionId();
	const begin = (ctx: ExtensionContext) => {
		if (!autoReasoningAvailable(ctx) || !ctx.model) return;
		if (!matches(ctx)) {
			baseline = { level: pi.getThinkingLevel(), model: ctx.model.id, session: ctx.sessionManager.getSessionId() };
			applied = undefined;
		}
	};
	const settle = (ctx: ExtensionContext) => {
		const restore =
			matches(ctx) && applied !== undefined && pi.getThinkingLevel() === applied ? baseline?.level : undefined;
		baseline = undefined;
		applied = undefined;
		if (restore !== undefined) pi.setThinkingLevel(restore);
	};
	const refresh = (ctx: ExtensionContext) => {
		activeContext = ctx;
		const active = pi.getActiveTools();
		if (autoReasoningAvailable(ctx)) {
			if (!active.includes("change_reasoning") && !listCodeModeToolNames().includes("change_reasoning"))
				pi.setActiveTools([...active, "change_reasoning"]);
		} else if (active.includes("change_reasoning"))
			pi.setActiveTools(active.filter((name) => name !== "change_reasoning"));
	};
	const tool: ToolDefinition<typeof parameters, ReasoningDetails> = {
		name: "change_reasoning",
		label: "Change reasoning",
		description:
			"Adjust Astra reasoning effort by work phase. The user's starting level is the floor, restored when the run settles.",
		promptGuidelines: ["Use change_reasoning for a change in work phase, not before each tool call."],
		parameters,
		...reasoningPresentation(),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (!autoReasoningAvailable(ctx))
				throw new Error(
					"Auto reasoning requires Astra Codex transport, Auto reasoning enabled, and ordinary reasoning mode",
				);
			begin(ctx);
			if (!baseline) throw new Error("No Astra reasoning baseline");
			const previous = pi.getThinkingLevel();
			if (previous !== (applied ?? baseline.level)) baseline.level = previous;
			const effective = levels.indexOf(params.level) < levels.indexOf(baseline.level) ? baseline.level : params.level;
			pi.setThinkingLevel(effective);
			applied = pi.getThinkingLevel();
			const details: ReasoningDetails = {
				version: 1,
				tool: "change_reasoning",
				status: "completed",
				level: applied,
				floor: baseline.level,
			};
			return { content: [{ type: "text", text: JSON.stringify({ level: applied, floor: baseline.level }) }], details };
		},
	};
	pi.registerTool(tool);
	const dispose = registerCodeModeFunctionTool(tool, {
		isActive: () => activeContext !== undefined && autoReasoningAvailable(activeContext),
		resultValue: (result) => ({ level: result.details?.level, floor: result.details?.floor }),
	});
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (_event, ctx) => {
		baseline = undefined;
		applied = undefined;
		refresh(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		refresh(ctx);
		begin(ctx);
	});
	pi.on("agent_end", (_event, ctx) => settle(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		settle(ctx);
		dispose();
	});
	return dispose;
}
