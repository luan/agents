import { expect, test } from "bun:test";
import { createAgentCallBreaker, normalizeItems, parseForkTurns } from "./index";
import { AGENT_TOOLS } from "./tool-names";

test("spawn input preserves exact dash-separated names", () => {
	expect(normalizeItems({ task_name: "root-cause", message: "Find the root cause." })).toEqual([
		{ task_name: "root-cause", message: "Find the root cause.", model_role: undefined },
	]);
	expect(() => normalizeItems({ task_name: "root_cause", message: "Find it." })).toThrow();
});

test("fork_turns accepts supported values", () => {
	expect(parseForkTurns(undefined)).toBe("all");
	expect(parseForkTurns("none")).toBe("none");
	expect(parseForkTurns("3")).toBe(3);
	expect(() => parseForkTurns("0")).toThrow();
	expect(() => parseForkTurns("1.0")).toThrow();
	expect(() => parseForkTurns("1e2")).toThrow();
});

test("repeat breaker resets after a different outcome", () => {
	const breaker = createAgentCallBreaker();
	const call = (outcome: string) => breaker.observe("session", AGENT_TOOLS.waitAgent, {}, outcome);
	expect(call("missing")).toBeUndefined();
	expect(call("missing")).toBeUndefined();
	expect(call("missing")).toContain("3 times");
	expect(call("progress")).toBeUndefined();
	expect(call("missing")).toBeUndefined();
});
