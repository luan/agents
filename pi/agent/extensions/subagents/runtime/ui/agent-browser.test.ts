import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../types";
import { AgentHarness, readAgentTranscriptFile } from "./agent-browser";

const record = {
	id: "worker",
	type: "task",
	description: "worker",
	status: "running",
	rootSessionId: "root",
	parentSessionId: "root",
	assignment: "work",
	cwd: "/tmp",
	events: [],
	toolUses: 0,
	startedAt: 1,
	lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
	compactionCount: 0,
	attachment: {
		mode: "terminal",
		sessionName: "pi-agent-worker",
		socketPath: "/tmp/worker.sock",
		command: "rmux",
		args: ["attach-session", "-t", "pi-agent-worker"],
	},
} satisfies AgentRecord;

test("agent browser dispatches terminal attachment separately from transcript browsing", async () => {
	const attached: string[] = [];
	const harness = new AgentHarness(
		[record],
		{
			steer: async () => false,
			stop: () => false,
			followUp: async () => false,
			attach: async (target, tui) => {
				attached.push(target.attachment!.sessionName);
				expect(tui.terminal.columns).toBe(120);
				return true;
			},
		},
		{ requestRender() {}, start() {}, stop() {}, terminal: { rows: 40, columns: 120 } } as never,
		{ fg: (_color, text) => text, bold: (text) => text },
		() => {},
	);

	harness.handleInput("t");
	await Bun.sleep(0);

	expect(attached).toEqual(["pi-agent-worker"]);
	harness.dispose();
});

test("reads growing and replaced file-backed transcripts", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-transcript-"));
	try {
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "session",
					timestamp: new Date().toISOString(),
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "one",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "first", timestamp: Date.now() },
				}),
				"",
			].join("\n"),
		);
		const restored = {
			...record,
			status: "completed",
			sessionFile,
			attachment: undefined,
		} satisfies AgentRecord;
		const first = readAgentTranscriptFile(restored)!;
		expect(first.messages.map((message) => message.role)).toEqual(["user"]);

		appendFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				id: "two",
				parentId: "one",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "second", timestamp: Date.now() },
			})}\n`,
		);
		const grown = readAgentTranscriptFile(restored, first)!;
		expect(grown.messages).toHaveLength(2);

		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "replacement",
					timestamp: new Date().toISOString(),
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "replacement",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "replacement", timestamp: Date.now() },
				}),
				"",
			].join("\n"),
		);
		const replaced = readAgentTranscriptFile(restored, grown)!;
		expect(replaced.messages).toHaveLength(1);

		rmSync(restored.sessionFile!);
		expect(readAgentTranscriptFile(restored, replaced)?.error).toBe("Transcript file is unavailable.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
