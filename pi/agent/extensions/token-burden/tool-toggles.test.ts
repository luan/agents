import { describe, expect, test } from "bun:test";
import { createToolToggleController } from "./tool-toggles";

type Handler = (...args: any[]) => unknown;

function createPi(activeTools: string[]) {
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

	const controller = createToolToggleController(pi, ["ls", "grab", "find"]);
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
});
