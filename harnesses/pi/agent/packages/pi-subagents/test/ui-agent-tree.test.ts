import { describe, expect, test } from "bun:test";
import { agentDisplayName, agentsWithAncestors, agentTreeRows } from "../src/ui/agent-tree.ts";

describe("agent tree", () => {
	test("orders roots and descendants by canonical id", () => {
		const rows = agentTreeRows([
			{ id: "/root/b" },
			{ id: "/root/a/two", parentId: "/root/a" },
			{ id: "/root/a" },
			{ id: "/root/a/one", parentId: "/root/a" },
		]);
		expect(rows.map(({ agent }) => agent.id)).toEqual(["/root/a", "/root/a/one", "/root/a/two", "/root/b"]);
		expect(rows.map(({ prefix }) => prefix)).toEqual(["├─", "│ ├─", "│ └─", "└─"]);
	});

	test("keeps the ancestry needed for a filtered widget", () => {
		const agents = [{ id: "/root/a" }, { id: "/root/a/child", parentId: "/root/a", active: true }, { id: "/root/b" }];
		expect(agentsWithAncestors(agents, (agent) => agent.active === true).map(({ id }) => id)).toEqual([
			"/root/a",
			"/root/a/child",
		]);
	});

	test("treats missing parents as roots and terminates on cycles", () => {
		const rows = agentTreeRows([
			{ id: "/root/orphan", parentId: "/root/missing" },
			{ id: "/root/a", parentId: "/root/b" },
			{ id: "/root/b", parentId: "/root/a" },
		]);
		expect(rows.map(({ agent }) => agent.id)).toEqual(["/root/orphan"]);
	});

	test("extracts only the final canonical path segment", () => {
		expect(agentDisplayName("/root/task/child")).toBe("child");
		expect(agentDisplayName(undefined)).toBeUndefined();
	});
});
