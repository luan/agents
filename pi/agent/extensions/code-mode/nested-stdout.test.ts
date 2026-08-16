import { expect, it } from "bun:test";
import { registerTool } from "../shared/tool-registry.ts";
import { buildCoreToolDeclarations } from "./nested-dispatch.ts";

// `r.text` for a nested `exec_command` prefixes 6 framing lines before the command's own output — measured live:
// "Command: gs log short --json / Chunk ID: … / Wall time: … / Process exited with code 0 / Original token count: 192 /
// Output:". So `JSON.parse(r.text)` cannot work, and 3 of 232 cells reached for `r.stdout` or `r.output` instead.
it("declares stdout on CallResult so a cell can parse a command's output", () => {
	registerTool({ registerTool() {} } as never, {
		name: "exec_command",
		description: "Run a command.",
		parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
		execute: () => ({ content: [] }),
	});

	const declarations = buildCoreToolDeclarations() ?? "";

	// An undeclared field is unreachable: the cell only knows what this type says.
	expect(declarations).toContain("stdout?: string");
});
