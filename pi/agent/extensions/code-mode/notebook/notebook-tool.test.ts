import { expect, it } from "bun:test";

import { normalizeNotebookRequest, notebookToolDefinition } from "./notebook-tool.ts";

it("accepts each action with only its own parameters", () => {
	expect(normalizeNotebookRequest({ action: "status" })).toEqual({ action: "status" });
	expect(normalizeNotebookRequest({ action: "status", query: "a*" })).toEqual({ action: "status", query: "a*" });
	expect(normalizeNotebookRequest({ action: "list", query: "a*" })).toEqual({ action: "list", query: "a*" });
	expect(normalizeNotebookRequest({ action: "save", name: "work" })).toEqual({ action: "save", name: "work" });
	expect(normalizeNotebookRequest({ action: "load", name: "work" })).toEqual({ action: "load", name: "work" });
	expect(normalizeNotebookRequest({ action: "prune", query: "tmp*" })).toEqual({ action: "prune", query: "tmp*" });
	for (const action of ["checkpoint", "restart", "diagnostics", "reset"]) {
		expect(normalizeNotebookRequest({ action })).toEqual({ action } as never);
	}
});

it("deduplicates the name list for pin, unpin, and release", () => {
	for (const action of ["pin", "unpin", "release"]) {
		expect(normalizeNotebookRequest({ action, names: ["a", "b", "a"] })).toEqual({
			action,
			names: ["a", "b"],
		} as never);
	}
});

it("rejects a parameter the action does not own", () => {
	expect(() => normalizeNotebookRequest({ action: "status", name: "work" })).toThrow(
		"notebook status accepts query only",
	);
	expect(() => normalizeNotebookRequest({ action: "list", names: ["a"] })).toThrow("notebook list accepts query only");
	expect(() => normalizeNotebookRequest({ action: "save", query: "a*" })).toThrow("notebook save accepts name only");
	expect(() => normalizeNotebookRequest({ action: "load", names: ["a"] })).toThrow("notebook load accepts name only");
	expect(() => normalizeNotebookRequest({ action: "pin", query: "a*" })).toThrow("notebook pin accepts names only");
	expect(() => normalizeNotebookRequest({ action: "unpin", name: "a" })).toThrow("notebook unpin accepts names only");
	expect(() => normalizeNotebookRequest({ action: "release", name: "a" })).toThrow(
		"notebook release accepts names only",
	);
	expect(() => normalizeNotebookRequest({ action: "prune", names: ["a"] })).toThrow(
		"notebook prune accepts query only",
	);
	for (const action of ["checkpoint", "restart", "diagnostics", "reset"]) {
		expect(() => normalizeNotebookRequest({ action, query: "a*" })).toThrow(`notebook ${action} accepts only action`);
	}
});

it("requires the parameter the action needs", () => {
	expect(() => normalizeNotebookRequest({ action: "save" })).toThrow("notebook save requires name");
	expect(() => normalizeNotebookRequest({ action: "load" })).toThrow("notebook load requires name");
	expect(() => normalizeNotebookRequest({ action: "pin" })).toThrow("notebook pin requires at least one name");
	expect(() => normalizeNotebookRequest({ action: "release", names: [] })).toThrow(
		"notebook release requires at least one name",
	);
	// A prune with no glob would match everything, so it is a caller error.
	expect(() => normalizeNotebookRequest({ action: "prune" })).toThrow("notebook prune requires query");
	expect(() => normalizeNotebookRequest({ action: "prune", query: "" })).toThrow("notebook prune requires query");
});

it("rejects an unknown action", () => {
	expect(() => normalizeNotebookRequest({ action: "delete" })).toThrow("Unsupported notebook action: delete");
});

it("returns a definition whose schema lists the twelve actions", () => {
	const definition = notebookToolDefinition(async () => ({ message: "ok", details: {} }));
	expect(definition.name).toBe("notebook");
	expect(definition.parameters.properties.action.anyOf.map((member) => member.const)).toEqual([
		"status",
		"list",
		"checkpoint",
		"save",
		"load",
		"pin",
		"unpin",
		"release",
		"prune",
		"restart",
		"diagnostics",
		"reset",
	]);
});

it("passes the normalized request through and returns the message as text", async () => {
	const seen: unknown[] = [];
	const definition = notebookToolDefinition(async (request) => {
		seen.push(request);
		return { message: "Notebook idle", details: { state: "idle" } };
	});
	const result = await definition.execute(
		"call-1",
		{ action: "release", names: ["b", "a", "b"] },
		undefined,
		undefined,
		{} as never,
	);
	expect(seen).toEqual([{ action: "release", names: ["b", "a"] }]);
	expect(result.content).toEqual([{ type: "text", text: "Notebook idle" }]);
	expect(result.details).toEqual({ state: "idle" });
});
