import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	type CodeModeToolAdapter,
	type CodeModeToolDetails,
	type CodeModeToolInput,
	type CodeModeToolScope,
	registerCodeModeToolAdapter,
} from "pi-code-mode/sdk";
import { type createToolSearchTool, executeToolSearch } from "./tools/tool-search/definition.ts";
import { renderToolSearchResult } from "./tools/tool-search/presentation.ts";
import type { ToolSearchDetails } from "./tools/tool-search/result.ts";

// type-boundary: The owning tool validates its TypeBox input; the bridge only forwards it.
type OpaqueToolInput = CodeModeToolInput;
type OpaqueToolDetails = CodeModeToolDetails;

export interface ToolSearchCodeModeBridge {
	scope(): CodeModeToolScope | undefined;
	dispose(): void;
}

export function registerToolSearchCodeModeAdapter(
	tool: ReturnType<typeof createToolSearchTool>,
): ToolSearchCodeModeBridge {
	let scope: CodeModeToolScope | undefined;
	const adapter: CodeModeToolAdapter = {
		name: tool.name,
		kind: "function",
		owner: tool,
		description: tool.description,
		parameters: tool.parameters,
		renderTrace(trace, context) {
			if (!trace.result?.details) return undefined;
			return renderToolSearchResult(
				{ content: [], details: trace.result.details as ToolSearchDetails },
				context.theme,
				{
					executionStarted: trace.status === "running",
					isError: trace.status === "error",
					invalidate: context.requestRender,
					lastComponent: context.lastComponent,
				},
				false,
			);
		},
		onScopeChange(nextScope) {
			scope = nextScope;
		},
		invoke(input: OpaqueToolInput) {
			if (!scope) throw new Error("tool_search has no active Code Mode scope");
			return executeToolSearch(input as { query: string; limit?: number }, scope) as Promise<
				AgentToolResult<OpaqueToolDetails>
			>;
		},
	};
	const dispose = registerCodeModeToolAdapter(adapter);
	return { scope: () => scope, dispose };
}
