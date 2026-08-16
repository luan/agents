import { describe, expect, test } from "bun:test";
import { parseDeclaredToolNames, toolReachResolver } from "./tool-reach.ts";
import { ToolReach } from "./types.ts";

// A deferred tool labelled blocked reads as capability taken away; the reverse reads as capability that is not there.
describe("tool reach", () => {
	const reachOf = toolReachResolver({
		activeToolNames: ["exec", "wait", "ask_user"],
		catalogToolNames: ["ask_user", "exec_command", "read", "codex_apps_github_create_issue"],
		declaredToolNames: ["exec_command", "read"],
		isHidden: (name) => name === "bash",
	});

	test("separates the direct surface from everything a cell can still call", () => {
		expect(reachOf("exec")).toBe(ToolReach.Direct);
		expect(reachOf("ask_user")).toBe(ToolReach.Direct);
		expect(reachOf("exec_command")).toBe(ToolReach.Declared);
		expect(reachOf("codex_apps_github_create_issue")).toBe(ToolReach.Deferred);
		expect(reachOf("bash")).toBe(ToolReach.Blocked);
	});

	test("reports a tool that is neither sent nor in the cell catalog as unreachable", () => {
		expect(reachOf("grep")).toBe(ToolReach.Unreachable);
	});

	test("reads the declared names back out of the prompt block", () => {
		const declarations = [
			"Core tools, already declared — call these directly, no lookup needed:",
			"",
			"  tools.exec_command({ cmd, workdir? })",
			"  tools.read({ path })",
			"",
			"Their full parameter documentation is in `ALL_TOOLS` inside the cell.",
		].join("\n");

		expect(parseDeclaredToolNames(declarations)).toEqual(["exec_command", "read"]);
		expect(parseDeclaredToolNames(undefined)).toEqual([]);
	});
});
