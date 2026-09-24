import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { historyItems } from "../src/core/history.ts";
import { latestWindow, NOTE_ENTRY, ORIGIN_ENTRY, readNotes, resolveNotePath, WINDOW_ENTRY } from "../src/core/state.ts";

test.each(["../secret", "/root/notes/../secret", "a//b", "/root/notes/a\\b", "/root/notes/a\0b", "/root/notes"])(
	"rejects invalid virtual note path %s",
	(path) => {
		expect(() => resolveNotePath(path, "/root/child")).toThrow();
	},
);
test("resolves local and peer note paths without filesystem access", () => {
	expect(resolveNotePath("checkpoint.md", "/root/child")).toEqual({ agentName: "/root/child", path: "checkpoint.md" });
	expect(resolveNotePath("/root/notes/checkpoint.md", "/root/child")).toEqual({
		agentName: "/root",
		path: "checkpoint.md",
	});
	expect(resolveNotePath("", "/root/child", true)).toEqual({ agentName: "/root/child", path: "" });
});
test("notes and windows track the active branch and preserve inherited history IDs", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(ORIGIN_ENTRY, { version: 1, id: "original-window" });
	session.appendMessage({ role: "user", content: "Original task", timestamp: 1 });
	const fork = session.appendCustomEntry(NOTE_ENTRY, { version: 1, path: "checkpoint", text: "before" });
	session.appendCustomEntry(NOTE_ENTRY, { version: 1, path: "checkpoint", text: "after" });
	session.appendCustomEntry(WINDOW_ENTRY, {
		version: 1,
		id: "next-window",
		previous: "original-window",
		checkpoint: "after",
	});
	expect(readNotes(session.getBranch()).get("checkpoint")?.text).toBe("after");
	expect(latestWindow(session.getBranch())?.state.id).toBe("next-window");
	session.branch(fork);
	expect(readNotes(session.getBranch()).get("checkpoint")?.text).toBe("before");
	expect(latestWindow(session.getBranch())).toBeUndefined();
	expect(historyItems(session.getBranch(), "new-fork-session")[0].window_id).toBe("original-window");
});
test("corrupt saved state fails closed", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(WINDOW_ENTRY, { version: 2, id: "invalid" });
	expect(() => latestWindow(session.getBranch())).toThrow("refusing to restore old context");
	session.appendCustomEntry(NOTE_ENTRY, { version: 1, path: "checkpoint", text: 42 });
	expect(() => readNotes(session.getBranch())).toThrow("Invalid saved note");
});
