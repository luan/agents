import { afterEach, expect, it } from "bun:test";
import { registerTool } from "../shared/tool-registry.ts";
import { clearSessionDeniedTools, setSessionDeniedTools } from "../tool-policy/policy.ts";
import { buildToolCatalog, callNestedTool, NestedToolError, sessionIdOf } from "./nested-dispatch.ts";

const SESSION = "denied-probe-session";
const OTHER = "sibling-probe-session";
const ctxFor = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });

afterEach(() => {
	clearSessionDeniedTools(SESSION);
	clearSessionDeniedTools(OTHER);
	for (const shutdown of shutdownHandlers.splice(0)) shutdown();
});

const shutdownHandlers: Array<() => void> = [];
function registerProbe(name: string) {
	const definition = {
		name,
		description: `probe ${name}`,
		execute: () => ({ content: [{ type: "text", text: `${name} ran` }] }),
	};
	for (const sessionId of [SESSION, OTHER]) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const api = {
			registerTool() {},
			on(event: string, handler: (event: unknown, ctx: unknown) => void) {
				handlers.set(event, handler);
			},
		};
		registerTool(api as never, definition);
		handlers.get("session_start")?.({}, ctxFor(sessionId));
		shutdownHandlers.push(() => handlers.get("session_shutdown")?.({}, ctxFor(sessionId)));
	}
}

// A read-only child must block the tool in both its catalog and nested dispatcher without changing sibling sessions.
it("refuses a denied tool inside a cell and names the restriction", async () => {
	registerProbe("probe_denied_write");
	setSessionDeniedTools(SESSION, ["probe_denied_write"]);

	const call = callNestedTool("probe_denied_write", {}, { ctx: ctxFor(SESSION) });

	await expect(call).rejects.toBeInstanceOf(NestedToolError);
	await expect(call).rejects.toThrow(/denied for this agent/);
	// Not "no tool named": a missing-tool message invites a retry or a shell workaround.
	await expect(call).rejects.not.toThrow(/No tool named/);
});

it("keeps a denied tool out of the catalog the cell is handed", () => {
	registerProbe("probe_denied_catalog");
	setSessionDeniedTools(SESSION, ["probe_denied_catalog"]);

	expect(buildToolCatalog(SESSION).map((e) => e.name)).not.toContain("probe_denied_catalog");
	// Same registry, no denial recorded: the parent and every other session still sees it.
	expect(buildToolCatalog(OTHER).map((e) => e.name)).toContain("probe_denied_catalog");
	expect(buildToolCatalog().map((e) => e.name)).toContain("probe_denied_catalog");
});

it("confines a denial to its own session", async () => {
	registerProbe("probe_denied_sibling");
	setSessionDeniedTools(SESSION, ["probe_denied_sibling"]);

	await expect(callNestedTool("probe_denied_sibling", {}, { ctx: ctxFor(OTHER) })).resolves.toBeDefined();
});

it("denies nothing for a session with an empty or absent list", async () => {
	registerProbe("probe_denied_empty");
	setSessionDeniedTools(SESSION, []);

	await expect(callNestedTool("probe_denied_empty", {}, { ctx: ctxFor(SESSION) })).resolves.toBeDefined();
	await expect(callNestedTool("probe_denied_empty", {}, { ctx: undefined })).resolves.toBeDefined();
});

it("reads no session from an unrecognised ctx, so a fabricated one denies nothing", () => {
	expect(sessionIdOf(undefined)).toBeUndefined();
	expect(sessionIdOf({})).toBeUndefined();
	expect(sessionIdOf({ sessionManager: {} })).toBeUndefined();
	expect(
		sessionIdOf({
			sessionManager: {
				getSessionId() {
					throw new Error("closed");
				},
			},
		}),
	).toBeUndefined();
	expect(sessionIdOf(ctxFor(SESSION))).toBe(SESSION);
});
