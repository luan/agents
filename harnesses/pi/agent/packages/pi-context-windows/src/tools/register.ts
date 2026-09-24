import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerCodeModeFunctionTool } from "@luan.sh/pi-code-mode/sdk";
import type { TSchema } from "typebox";
import type { ContextToolDetails } from "./result.ts";
import { contextPresentation } from "./presentation.ts";

export function registerContextTool<Schema extends TSchema>(
	pi: ExtensionAPI,
	name: string,
	description: string,
	parameters: Schema,
	execute: (
		input: Parameters<ToolDefinition<Schema>["execute"]>[1],
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<ContextToolDetails>>,
	nested = true,
): () => void {
	const tool: ToolDefinition<Schema, ContextToolDetails> = {
		name,
		label: name.replaceAll("__", "."),
		description,
		parameters,
		...contextPresentation<Schema>(name),
		executionMode:
			name.startsWith("notes__write") || name.startsWith("notes__append") || name === "new_context"
				? "sequential"
				: "parallel",
		async execute(_id, input, _signal, _update, ctx) {
			return execute(input, ctx);
		},
	};
	pi.registerTool(tool);
	return nested ? registerCodeModeFunctionTool(tool, { resultValue: (result) => result.details.output }) : () => {};
}
