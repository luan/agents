import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolToggleController, loadToolToggleConfig } from "./tool-toggles";

type Handler = (...args: any[]) => unknown;

function createPi(activeTools: string[], disabledTools = ["ls", "grab", "find"], configPath?: string) {
	const handlers = new Map<string, Handler[]>();
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
			setActiveToolsCalls.push(next);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	const controller = createToolToggleController(pi, disabledTools, configPath);
	controller.install();

	return { controller, handlers, setActiveToolsCalls, getActiveTools: () => activeTools };
}

describe("token-burden tool toggles", () => {
	test("removes configured default tools from active tools", () => {
		const pi = createPi(["read", "ls", "grab", "find", "exec_command"]);

		pi.handlers.get("session_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["read", "exec_command"]);
		expect(pi.setActiveToolsCalls).toEqual([["read", "exec_command"]]);
	});

	test("blocks configured tool calls as a safety net while inactive", () => {
		const pi = createPi(["read", "exec_command"]);

		const result = pi.handlers.get("tool_call")?.[0]?.({ toolName: "grab" }, {});

		expect(result).toEqual({
			block: true,
			reason: "grab is disabled by the token-burden extension. Toggle it on from /token-burden if needed.",
		});
	});

	test("toggle result enables namespaced tools and allows them through safety net", () => {
		const pi = createPi(["read", "exec_command"]);

		const toggleResult = pi.controller.setToolActive("functions.find", true);
		const blockResult = pi.handlers.get("tool_call")?.[0]?.({ toolName: "functions.find" }, {});

		expect(toggleResult).toEqual({
			applied: true,
			activeToolNames: ["read", "exec_command", "functions.find"],
		});
		expect(blockResult).toBeUndefined();
		expect(pi.getActiveTools()).toEqual(["read", "exec_command", "functions.find"]);
	});

	test("toggle result disables active tools and blocks later calls", () => {
		const pi = createPi(["read", "exec_command"]);

		pi.controller.setToolActive("exec_command", false);
		const blockResult = pi.handlers.get("tool_call")?.[0]?.({ toolName: "exec_command" }, {});

		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(blockResult).toEqual({
			block: true,
			reason: "exec_command is disabled by the token-burden extension. Toggle it on from /token-burden if needed.",
		});
	});

	test("persists disabled tool changes to config", () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "token-burden-tools-")), "config.json");
		writeFileSync(configPath, `${JSON.stringify({ disabledTools: ["find"] })}\n`, "utf8");
		const pi = createPi(["read", "exec_command"], loadToolToggleConfig(configPath).disabledTools, configPath);

		pi.controller.setToolActive("functions.find", true);
		pi.controller.setToolActive("exec_command", false);

		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			disabledTools: ["exec_command"],
		});
	});

	test("loads an explicitly empty disabled tool list without restoring defaults", () => {
		const configPath = join(mkdtempSync(join(tmpdir(), "token-burden-tools-")), "config.json");
		writeFileSync(configPath, `${JSON.stringify({ disabledTools: [] })}\n`, "utf8");

		expect(loadToolToggleConfig(configPath)).toEqual({ disabledTools: [] });
	});
});
