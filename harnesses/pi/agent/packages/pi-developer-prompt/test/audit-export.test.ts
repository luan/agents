import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEVELOPER_AUDIT_ENTRY_TYPE } from "../src/audit-entries.ts";

test("Pi's HTML export retains prompt audit entry data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-developer-prompt-export-"));
	const sessionPath = join(directory, "session.jsonl");
	const outputPath = join(directory, "session.html");
	try {
		const timestamp = "2026-08-18T00:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "audit-export", timestamp, cwd: "/repo" },
			{
				type: "message",
				id: "user-message",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "Inspect the prompt." }], timestamp: 0 },
			},
			{
				type: "custom",
				id: "developer-audit",
				parentId: "user-message",
				timestamp,
				customType: DEVELOPER_AUDIT_ENTRY_TYPE,
				data: {
					role: "developer",
					id: "skills",
					content: "Stored developer catalogue.",
				},
			},
		];
		await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const process = Bun.spawn(["pi", "--export", sessionPath, outputPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const html = await readFile(outputPath, "utf8");
		const encodedSession = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		expect(encodedSession).toBeDefined();
		const exported = JSON.parse(Buffer.from(encodedSession ?? "", "base64").toString("utf8"));
		expect(exported.entries).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: DEVELOPER_AUDIT_ENTRY_TYPE,
				data: {
					role: "developer",
					id: "skills",
					content: "Stored developer catalogue.",
				},
			}),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
