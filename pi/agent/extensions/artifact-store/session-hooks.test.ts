import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactStoreFor } from "../shared/artifact-store.ts";
import { runInSession } from "../shared/session-context.ts";
import piExtension from "./index.js";
import { captureExecOutput } from "./pi/capture.ts";
import {
	clearCurrentArtifactSession,
	getCurrentArtifactSession,
	getCurrentArtifactSessionId,
	setCurrentArtifactSession,
} from "./pi/current-session.js";
import { isExecCaptureEnabled, resetExecCaptureEnabled } from "./pi/index.js";

function createMockPi() {
	const hooks = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const tools: string[] = [];
	return {
		hooks,
		commands,
		tools,
		on(name: string, handler: (...args: any[]) => any) {
			hooks.set(name, handler);
		},
		registerCommand(name: string, def: { handler: (...args: any[]) => any }) {
			commands.set(name, def);
		},
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
	};
}

afterEach(() => {
	resetExecCaptureEnabled();
});

describe("artifact-store extension lifecycle", () => {
	it("tracks session identity and exposes no model-facing tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "artifact-store-lifecycle-"));

		const pi = createMockPi();
		piExtension(pi);
		expect(isExecCaptureEnabled()).toBe(true);
		// The store is reached through `artifact://` and the bounding minter, never
		// through a tool the model can see. A registration here is a cost regression.
		expect(pi.tools).toEqual([]);
		expect([...pi.hooks.keys()].sort()).toEqual(["session_shutdown", "session_start"]);
		expect([...pi.commands.keys()]).toEqual(["artifacts"]);

		const sessionFile = join(dir, "2026-08-12T00-00-00-000Z_test-session.jsonl");
		pi.hooks.get("session_start")?.(
			{},
			{ sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" } },
		);
		expect(getCurrentArtifactSessionId("test-session")).toBe("test-session");
		expect(getCurrentArtifactSession("test-session").sessionFile).toBe(sessionFile);

		// The artifact directory is derived from the session file, so status names
		// it before anything has been written to it.
		const status = await pi.commands.get("artifacts")?.handler({});
		expect(status.text).toContain(join(dir, "2026-08-12T00-00-00-000Z_test-session"));
		expect(status.text).toContain("no artifacts yet");

		pi.hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => "test-session" } });
		expect(getCurrentArtifactSessionId("test-session")).toBeUndefined();
	});

	it("keeps root artifact state when a child starts and shuts down", () => {
		const root = createMockPi();
		const child = createMockPi();
		piExtension(root);
		piExtension(child);
		root.hooks.get("session_start")?.(
			{},
			{ sessionManager: { getSessionFile: () => "/tmp/root.jsonl", getSessionId: () => "root-session" } },
		);
		child.hooks.get("session_start")?.(
			{},
			{ sessionManager: { getSessionFile: () => "/tmp/child.jsonl", getSessionId: () => "child-session" } },
		);

		expect(getCurrentArtifactSession("root-session").sessionFile).toBe("/tmp/root.jsonl");
		expect(getCurrentArtifactSession("child-session").sessionFile).toBe("/tmp/child.jsonl");
		child.hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => "child-session" } });
		expect(getCurrentArtifactSession("root-session").sessionFile).toBe("/tmp/root.jsonl");
		root.hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => "root-session" } });
	});
	it("uses ALS when owner ID is absent and explicit owner overrides it", () => {
		setCurrentArtifactSession({ sessionFile: "/tmp/root.jsonl", sessionId: "root-session" }, "root-session");
		setCurrentArtifactSession({ sessionFile: "/tmp/child.jsonl", sessionId: "child-session" }, "child-session");
		try {
			expect(runInSession("child-session", () => getCurrentArtifactSession().sessionFile)).toBe("/tmp/child.jsonl");
			expect(runInSession("child-session", () => getCurrentArtifactSession("root-session").sessionFile)).toBe(
				"/tmp/root.jsonl",
			);
		} finally {
			clearCurrentArtifactSession("root-session");
			clearCurrentArtifactSession("child-session");
		}
	});

	it("captures into the explicit owner session after child context replaces ALS", async () => {
		const dir = mkdtempSync(join(tmpdir(), "artifact-store-capture-"));
		const rootFile = join(dir, "root.jsonl");
		const childFile = join(dir, "child.jsonl");
		setCurrentArtifactSession({ sessionFile: rootFile, sessionId: "root-session" }, "root-session");
		setCurrentArtifactSession({ sessionFile: childFile, sessionId: "child-session" }, "child-session");
		try {
			const result = await runInSession("child-session", () =>
				captureExecOutput({ ownerSessionId: "root-session", label: "exec" }, { output: "root output" }),
			);

			expect(result.capture?.artifactId).toBe("0");
			expect(await artifactStoreFor({ sessionFile: rootFile }).listIds()).toEqual(["0"]);
			expect(await artifactStoreFor({ sessionFile: childFile }).listIds()).toEqual([]);
		} finally {
			clearCurrentArtifactSession("root-session");
			clearCurrentArtifactSession("child-session");
		}
	});
});
