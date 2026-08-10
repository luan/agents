import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import piExtension from "./index.js";
import { resetExecCommandContextGuardEnabled } from "./pi/index.js";

type RegisteredTool = {
	name: string;
	parameters: Record<string, unknown>;
	renderCall?: (params: unknown, theme: any, context: any) => any;
	renderResult?: (result: any, state: any, theme: any, context: any) => any;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		ctx?: { cwd?: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
};

afterEach(() => {
	resetExecCommandContextGuardEnabled();
});

function createMockPi() {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		on() {},
		registerCommand() {},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	};
}

describe("Context Guard v2 Pi tools", () => {
	it("registers only strict v2 tools", async () => {
		const pi = createMockPi();
		piExtension(pi);
		expect(pi.tools.map((tool) => tool.name)).toEqual(["cg_search", "cg_status", "cg_purge"]);
		for (const tool of pi.tools) {
			expect(tool.parameters.type ?? tool.parameters.anyOf).toBeDefined();
			expect(JSON.stringify(tool.parameters)).not.toContain('"additionalProperties":true');
		}
	});

	it("enforces exact purge schemas", async () => {
		const pi = createMockPi();
		piExtension(pi);
		const purge = pi.tools.find((tool) => tool.name === "cg_purge")!;
		await expect(purge.execute("bad-1", { confirm: false, scope: "project" })).rejects.toThrow();
		await expect(purge.execute("bad-2", { confirm: true, scope: "project", sessionId: "x" })).rejects.toThrow();
		await expect(purge.execute("bad-3", { confirm: true, scope: "session" })).rejects.toThrow();
	});
});
