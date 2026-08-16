import { expect, it } from "bun:test";
import { registerTool } from "../shared/tool-registry.ts";
import { buildCoreToolDeclarations } from "./nested-dispatch.ts";

// Registered inside each test, as core-declarations.test.ts does: the global registry does not survive module load.
function declareFive() {
	for (const name of ["read", "search", "exec_command", "edit", "write"]) {
		registerTool({ registerTool() {} } as never, {
			name,
			description: `Run ${name}.`,
			parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
			execute: () => ({ content: [] }),
		});
	}
}

// A child received the whole Declared roster regardless of its own allowlist: measured 4,801 tokens for 9 tools
// against 995 for a three-tool reviewer, so 3,806 resident tokens per subagent turn (79%).
it("scopes the block to the allowlist", () => {
	declareFive();

	const scoped = buildCoreToolDeclarations(["read", "search", "exec_command"]) ?? "";

	expect(scoped).toContain("read(input: string)");
	expect(scoped).toContain("exec_command(input: string)");
	expect(scoped).not.toContain("edit(");
	expect(scoped).not.toContain("write(");
});

// The pinned-runner lesson: a filter that can empty the block is how the original zero-tools bug happened.
it("treats an absent or empty allowlist as every declared tool", () => {
	declareFive();

	const full = buildCoreToolDeclarations() ?? "";

	expect(buildCoreToolDeclarations([])).toBe(full);
	expect(full).toContain("edit(input: string)");
	expect(full).toContain("write(input: string)");
});

// The block gates the declaration, not capability: the registry is process-global, so an omitted tool stays callable.
it("keeps saying that omitted tools remain reachable", () => {
	declareFive();

	expect(buildCoreToolDeclarations(["read"]) ?? "").toContain("They are still on `tools`");
});
