import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createSideChatRuntime,
	createSideChatCommand,
	prepareSideChatSession,
	SIDE_CONVERSATION_BOUNDARY,
	sideChatSessionRoot,
	type SideChatRuntime,
	type SideChatSessionWrite,
	writeSideChatSession,
} from "../src/session.ts";

test("keeps sessionless child sessions out of the working directory", () => {
	const context = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionDir: () => "/tmp/project",
			getSessionFile: () => undefined,
			getSessionId: () => "sessionless-root",
		},
	} as never;

	expect(sideChatSessionRoot(context)).toBe(join(tmpdir(), "pi-side-chat", "sessionless-root"));
});

test("keeps persistent child sessions under Pi's session directory", () => {
	const context = {
		sessionManager: {
			getSessionDir: () => "/tmp/pi-sessions/project",
			getSessionFile: () => "/tmp/pi-sessions/project/root.jsonl",
		},
	} as never;

	expect(sideChatSessionRoot(context)).toBe("/tmp/pi-sessions/project");
});

test("defers projecting the parent branch until a new side chat is prepared", () => {
	let branchReads = 0;
	const context = {
		cwd: "/tmp/project",
		ui: { theme: { name: "test" } },
		sessionManager: {
			getSessionDir: () => "/tmp/pi-side-chat",
			getSessionFile: () => "/tmp/pi-parent.jsonl",
			getBranch: () => {
				branchReads += 1;
				return [];
			},
		},
	} as never;
	const runtime = createSideChatRuntime(context, () => {});
	const tab = {
		id: "side-chat:11111111-1111-4111-8111-111111111111",
		label: "Side 1",
		sessionId: "11111111-1111-4111-8111-111111111111",
	};

	expect(branchReads).toBe(0);
	prepareSideChatSession(runtime, tab);
	expect(branchReads).toBe(1);
});

test("new side chats always create unique exact sessions", () => {
	const writes: SideChatSessionWrite[] = [];
	const root = "/tmp/pi-side-chat";
	const runtime = {
		cwd: "/tmp/project",
		sessionRoot: root,
		theme: {
			name: "test",
			getColorMode: () => "truecolor",
			getFgAnsi: () => "\x1b[39m",
			getBgAnsi: () => "\x1b[49m",
		},
		inheritedEntries: () => [],
		writeSession: (session: SideChatSessionWrite) => writes.push(session),
	} as never as SideChatRuntime;
	const firstTab = {
		id: "side-chat:11111111-1111-4111-8111-111111111111",
		label: "Side 1",
		sessionId: "11111111-1111-4111-8111-111111111111",
	};
	const secondTab = {
		id: "side-chat:22222222-2222-4222-8222-222222222222",
		label: "Side 1",
		sessionId: "22222222-2222-4222-8222-222222222222",
	};
	const first = createSideChatCommand(prepareSideChatSession(runtime, firstTab));
	const second = createSideChatCommand(prepareSideChatSession(runtime, secondTab));
	expect(first).toContain("side-chats/11111111-1111-4111-8111-111111111111");
	expect(second).toContain("side-chats/22222222-2222-4222-8222-222222222222");
	expect(first).toContain("'--session-id' '11111111-1111-4111-8111-111111111111'");
	expect(second).toContain("'--session-id' '22222222-2222-4222-8222-222222222222'");
	expect(first).not.toContain("'--continue'");
	expect(second).not.toContain("'--continue'");
	expect(first).not.toBe(second);
	expect(writes.map((write) => write.sessionId)).toEqual([firstTab.sessionId, secondTab.sessionId]);
});

test("writes inherited history followed by Codex's hidden side-conversation boundary", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-side-chat-"));
	try {
		const sessionDir = join(root, "side-chat");
		const inheritedEntry = {
			type: "message" as const,
			id: "parent-message",
			parentId: "omitted-extension-state",
			timestamp: "2026-08-31T00:00:00.000Z",
			message: {
				role: "user" as const,
				content: [{ type: "text" as const, text: "parent question" }],
				timestamp: 1,
			},
		};
		writeSideChatSession({
			cwd: "/tmp/project",
			sessionDir,
			sessionId: "11111111-1111-4111-8111-111111111111",
			label: "Side 1",
			themePath: join(sessionDir, "theme.json"),
			themeJson: "{}\n",
			inheritedEntries: [inheritedEntry],
			parentSession: "/tmp/pi-parent.jsonl",
		});
		const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		const [header, sessionInfo, inherited, boundary] = readFileSync(join(sessionDir, files[0]!), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(header.id).toBe("11111111-1111-4111-8111-111111111111");
		expect(header.parentSession).toBe("/tmp/pi-parent.jsonl");
		expect(sessionInfo.type).toBe("session_info");
		expect(inherited).toEqual({ ...inheritedEntry, parentId: sessionInfo.id });
		expect(boundary).toMatchObject({
			type: "custom_message",
			customType: "pi-side-chat-boundary",
			content: SIDE_CONVERSATION_BOUNDARY,
			display: false,
			parentId: inherited.id,
		});
		const context = SessionManager.open(join(sessionDir, files[0]!), sessionDir).buildSessionContext();
		expect(convertToLlm(context.messages).at(-1)).toEqual({
			role: "user",
			content: [{ type: "text", text: SIDE_CONVERSATION_BOUNDARY }],
			timestamp: expect.any(Number),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
