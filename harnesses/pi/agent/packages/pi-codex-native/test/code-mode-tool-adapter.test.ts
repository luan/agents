import { expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCodeModeToolAdapterRegistry } from "pi-code-mode/sdk";
import { registerCodeModeFunctionTool } from "../src/code-mode-tool-adapter.ts";

test("the Code Mode adapter invokes the same tool behavior and disposes by identity", async () => {
	const tool = {
		name: "test_web_run",
		label: "test_web_run",
		description: "Test web tool.",
		parameters: { type: "object", properties: {} },
		prepareArguments: (input: unknown) => ({ input }),
		async execute(toolCallId: string, input: unknown) {
			return { content: [{ type: "text", text: JSON.stringify({ toolCallId, input }) }], details: {} };
		},
	} as unknown as ToolDefinition;
	const dispose = registerCodeModeFunctionTool(tool);
	const registry = getCodeModeToolAdapterRegistry();
	const adapter = registry.adapters.get(tool.name)!;
	const prepared = adapter.prepareInput?.("query");
	const result = await adapter.invoke(
		prepared,
		{
			cwd: "/tmp",
			toolCallId: "code-mode-1",
			extensionContext: {} as ExtensionContext,
		},
		new AbortController().signal,
	);

	expect(result).toMatchObject({
		content: [{ type: "text", text: JSON.stringify({ toolCallId: "code-mode-1", input: { input: "query" } }) }],
	});
	dispose();
	expect(registry.adapters.get(tool.name)).toBeUndefined();
});
