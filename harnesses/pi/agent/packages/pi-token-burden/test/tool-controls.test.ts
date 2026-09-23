import { describe, expect, test } from "bun:test";
import { type ToolControlRuntime, ToolControlService } from "../src/runtime/tool-controls.ts";

function runtime(overrides: Partial<ToolControlRuntime> = {}) {
	let active = ["read", "bash"];
	const calls: string[][] = [];
	const value: ToolControlRuntime = {
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "search" }],
		getActiveTools: () => active,
		setActiveTools: (names) => {
			calls.push(names);
			active = names;
		},
		waitForIdle: async () => {},
		...overrides,
	};
	return { value, calls, active: () => active };
}

describe("ToolControlService", () => {
	test("disables one tool while preserving unrelated active tools", async () => {
		const state = runtime();
		const result = await new ToolControlService(state.value).toggle("read", false);
		expect(result.applied).toBe(true);
		expect(state.active()).toEqual(["bash"]);
		expect(state.calls).toEqual([["bash"]]);
	});

	test("enables a known tool and waits before applying", async () => {
		let idle = false;
		const state = runtime({
			waitForIdle: async () => {
				idle = true;
			},
		});
		const result = await new ToolControlService(state.value).toggle("search", true);
		expect(idle).toBe(true);
		expect(result.applied).toBe(true);
		expect(state.active()).toEqual(["read", "bash", "search"]);
	});

	test("rejects unknown tools without changing the active set", async () => {
		const state = runtime();
		const result = await new ToolControlService(state.value).toggle("missing", true);
		expect(result).toMatchObject({ applied: false, reason: "unknown-tool" });
		expect(state.calls).toHaveLength(0);
		expect(state.active()).toEqual(["read", "bash"]);
	});

	test("reports busy when idle coordination is unavailable", async () => {
		const state = runtime({ waitForIdle: undefined });
		const result = await new ToolControlService(state.value).toggle("read", false);
		expect(result).toMatchObject({ applied: false, reason: "busy" });
		expect(state.calls).toHaveLength(0);
	});

	test("reports errors and leaves application unconfirmed", async () => {
		const state = runtime({
			setActiveTools: () => {
				throw new Error("busy");
			},
		});
		const result = await new ToolControlService(state.value).toggle("read", false);
		expect(result).toMatchObject({ applied: false, reason: "error" });
	});
});
