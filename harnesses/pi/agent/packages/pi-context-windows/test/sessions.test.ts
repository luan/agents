import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NOTE_ENTRY, readNotes } from "../src/core/state.ts";
import { bindSession, resolveSession } from "../src/runtime/sessions.ts";

function flush(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "Task", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Checkpoint" }],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	});
}

test("closed child notes resolve across cwd and concurrent appends share the current transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-tree-"));
	const parent = SessionManager.create(root, join(root, "parent"));
	flush(parent);
	const child = SessionManager.create(join(root, "different-cwd"), join(root, "child"));
	child.appendCustomEntry("session.identity/v1", {
		version: 1,
		rootSessionId: parent.getSessionId(),
		rootSessionFile: parent.getSessionFile(),
		agentName: "/root/child",
		interactive: false,
	});
	flush(child);
	parent.appendCustomEntry("subagents:agent-v1", { version: 1, agent: { transcriptFile: child.getSessionFile() } });
	const dispose = bindSession(
		{
			appendEntry: (type, data) => {
				parent.appendCustomEntry(type, data);
			},
		},
		{ sessionManager: parent },
	);
	try {
		const first = await resolveSession({ sessionManager: parent }, "child");
		first.append(NOTE_ENTRY, { version: 1, path: "checkpoint", text: "A" });
		await Promise.all(
			["B", "C"].map(async (text) => {
				const access = await resolveSession({ sessionManager: parent }, "child");
				access.append(NOTE_ENTRY, {
					version: 1,
					path: "checkpoint",
					text: (readNotes(access.entries()).get("checkpoint")?.text ?? "") + text,
				});
			}),
		);
		expect(readNotes(first.entries()).get("checkpoint")?.text).toBe("ABC");
		const restored = SessionManager.open(child.getSessionFile()!);
		expect(readNotes(restored.getBranch()).get("checkpoint")?.text).toBe("ABC");
		expect((await resolveSession({ sessionManager: restored }, "/root")).id).toBe(parent.getSessionId());
		const stranger = SessionManager.create(root, join(root, "stranger"));
		flush(stranger);
		await expect(resolveSession({ sessionManager: stranger }, "/root/child")).rejects.toThrow("unavailable");
	} finally {
		dispose();
		await rm(root, { recursive: true, force: true });
	}
});
