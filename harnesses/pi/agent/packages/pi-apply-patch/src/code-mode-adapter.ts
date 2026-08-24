import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type CodeModeToolAdapter,
	type CodeModeToolDetails,
	type CodeModeToolInput,
	type CodeModeToolInvocationContext,
	registerCodeModeToolAdapter,
} from "pi-code-mode/sdk";
import { renderApplyPatchResult } from "./tools/apply-patch/presentation.ts";
import type { ApplyPatchToolDetails } from "./tools/apply-patch/result.ts";

// type-boundary: Pi permits each tool to choose its details payload; callers forward it without inspection.
type OpaqueToolDetails = CodeModeToolDetails;

interface ApplyPatchTool {
	name: string;
	description: string;
	execute(
		toolCallId: string,
		params: { input: string },
		signal: AbortSignal | undefined,
		onUpdate: (result: AgentToolResult<ApplyPatchToolDetails>) => void,
		context: ExtensionContext,
	): Promise<AgentToolResult<ApplyPatchToolDetails>>;
}

export function registerApplyPatchCodeModeAdapter(tool: ApplyPatchTool): () => void {
	const adapter: CodeModeToolAdapter = {
		name: tool.name,
		kind: "freeform",
		owner: tool,
		description: tool.description,
		resultValue(result) {
			const details = result.details;
			return details && typeof details === "object" && "result" in details ? Reflect.get(details, "result") : details;
		},
		renderTrace(trace, context) {
			if (typeof trace.input !== "string" || !isApplyPatchDetails(trace.result?.details)) return undefined;
			const result = {
				content: trace.result.content.flatMap((item) => {
					if (!item || typeof item !== "object") return [];
					const type = Reflect.get(item, "type");
					const text = Reflect.get(item, "text");
					return type === "text" && typeof text === "string" ? [{ type: "text" as const, text }] : [];
				}),
				details: trace.result.details,
			} satisfies AgentToolResult<ApplyPatchToolDetails>;
			return renderApplyPatchResult(
				result,
				{ expanded: false, isPartial: trace.status === "running" },
				context.theme,
				{
					executionStarted: true,
					isError: trace.status === "error",
					invalidate: context.requestRender,
					lastComponent: context.lastComponent,
				},
				trace.input,
			);
		},
		async invoke(input: CodeModeToolInput, context: CodeModeToolInvocationContext, signal) {
			if (typeof input !== "string") throw new Error("apply_patch requires raw patch text");
			const result = await tool.execute(
				context.toolCallId,
				{ input },
				signal,
				(result) => context.onUpdate?.(result),
				context.extensionContext,
			);
			if (result.details.status === "partial_failure") {
				context.onUpdate?.(result);
				const message = result.content.find((item) => item.type === "text")?.text;
				throw new Error(message ?? "apply_patch partially failed");
			}
			return result as AgentToolResult<OpaqueToolDetails>;
		},
	};
	return registerCodeModeToolAdapter(adapter);
}

function isApplyPatchDetails(value: CodeModeToolDetails): value is ApplyPatchToolDetails {
	if (!value || typeof value !== "object") return false;
	const status = Reflect.get(value, "status");
	return status === "running" || status === "success" || status === "partial_failure";
}
