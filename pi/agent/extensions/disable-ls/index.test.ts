import { describe, expect, test } from "bun:test";
import disableLsExtension from "./disable-ls.ts";

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

	disableLsExtension(pi as any);

	return { handlers, setActiveToolsCalls, getActiveTools: () => activeTools };
}

describe("disable-ls extension", () => {
	test("removes ls from active tools", () => {
		const pi = createPi(["read", "ls", "exec_command"]);

		pi.handlers.get("session_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["read", "exec_command"]);
		expect(pi.setActiveToolsCalls).toEqual([["read", "exec_command"]]);
	});

	test("does nothing when ls is already inactive", () => {
		const pi = createPi(["read", "exec_command"]);

		pi.handlers.get("before_agent_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["read", "exec_command"]);
		expect(pi.setActiveToolsCalls).toEqual([]);
	});

	test("blocks ls tool calls as a safety net", () => {
		const pi = createPi(["read", "exec_command"]);

		const result = pi.handlers.get("tool_call")?.[0]?.({ toolName: "ls" }, {});

		expect(result).toEqual({
			block: true,
			reason: "ls is disabled. Use an available shell command tool instead.",
		});
	});
});
