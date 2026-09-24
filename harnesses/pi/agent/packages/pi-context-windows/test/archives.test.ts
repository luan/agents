import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { archivedHistory, ARCHIVE_ENTRY } from "../src/core/archives.ts";
import { historyItems } from "../src/core/history.ts";

test("archives restore outgoing windows in order without exposing unrelated branches", () => {
	const session = SessionManager.inMemory();
	const base = session.appendCustomEntry("origin", {});
	const first = session.appendMessage({ role: "user", content: "First window", timestamp: 1 });
	session.branch(base);
	session.appendMessage({ role: "user", content: "Unrelated branch", timestamp: 2 });
	session.branch(base);
	session.appendCustomEntry(ARCHIVE_ENTRY, { version: 1, from: first, base });
	const second = session.appendMessage({ role: "user", content: "Second window", timestamp: 3 });
	session.branch(base);
	session.appendCustomEntry(ARCHIVE_ENTRY, { version: 1, from: second, base });
	session.appendMessage({ role: "user", content: "Current window", timestamp: 4 });
	const restored = archivedHistory(session.getEntries(), session.getBranch());
	expect(historyItems(restored, session.getSessionId()).map((item) => JSON.parse(item.content).content)).toEqual([
		"First window",
		"Second window",
		"Current window",
	]);
	expect(new Set(restored.map((entry) => entry.id)).size).toBe(restored.length);
	session.branch(base);
	expect(archivedHistory(session.getEntries(), session.getBranch()).map((entry) => entry.id)).toEqual([base]);
});

test.each(["missing", "wrong-base"])("invalid archive %s refuses partial history", (failure) => {
	const session = SessionManager.inMemory();
	const base = session.appendCustomEntry("origin", {});
	const from = session.appendMessage({ role: "user", content: "Archived", timestamp: 1 });
	session.branch(base);
	session.appendCustomEntry(ARCHIVE_ENTRY, {
		version: 1,
		from: failure === "missing" ? "absent" : from,
		base: failure === "wrong-base" ? "absent" : base,
	});
	expect(() => archivedHistory(session.getEntries(), session.getBranch())).toThrow("Context archive");
});
