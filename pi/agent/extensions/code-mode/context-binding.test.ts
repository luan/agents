import { afterEach, expect, it } from "bun:test";
import { registerTool, resetToolRegistry } from "../shared/tool-registry.ts";
import codeModeExtension from "./index.ts";

afterEach(() => {
	resetToolRegistry();
});

it("keeps nested tool calls bound to the cell session that issued them", async () => {
	const tools = new Map<string, any>();
	const seenSessionIds: string[] = [];
	const probe = {
		name: "probe_context_binding",
		execute: async (_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) => {
			seenSessionIds.push(ctx?.sessionManager?.getSessionId?.());
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	for (const sessionId of ["session-a", "session-b"]) {
		let start: ((event: unknown, ctx: unknown) => void) | undefined;
		registerTool(
			{
				registerTool() {},
				on(event: string, handler: (event: unknown, ctx: unknown) => void) {
					if (event === "session_start") start = handler;
				},
			} as never,
			probe,
		);
		start?.({}, { sessionManager: { getSessionId: () => sessionId } });
	}
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		on() {},
		sendMessage() {},
		events: { on: () => () => {}, emit() {} },
	};
	codeModeExtension(pi as any);
	const execute = tools.get("exec");
	if (!execute) throw new Error("code-mode did not register exec");
	const sessionA = { sessionManager: { getSessionId: () => "session-a", getBranch: () => [] }, cwd: process.cwd() };
	const sessionB = { sessionManager: { getSessionId: () => "session-b", getBranch: () => [] }, cwd: process.cwd() };
	const first = execute.execute(
		"cell-a",
		{ code: "await new Promise((resolve) => setTimeout(resolve, 30)); await tools.probe_context_binding({});" },
		undefined,
		undefined,
		sessionA,
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await execute.execute("cell-b", { code: "await tools.probe_context_binding({});" }, undefined, undefined, sessionB);
	await first;

	expect([...seenSessionIds].sort()).toEqual(["session-a", "session-b"]);
});
