import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import { PromptStorageStore } from "../src/runtime/store.ts";

async function withStore(run: (store: PromptStorageStore, directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "pi-prompt-store-"));
	const previous = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = directory;
	const store = new PromptStorageStore();
	try {
		await run(store, directory);
	} finally {
		await store.close();
		if (previous === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}

test("close settles a pending stash write before reopening", async () => {
	await withStore(async (store, cwd) => {
		let inserted = false;
		const inserting = store.insert("draft", cwd).then(() => {
			inserted = true;
		});
		await store.close();
		try {
			expect(inserted).toBe(true);
		} finally {
			await inserting;
		}
		expect((await store.listStashes(cwd)).map((item) => item.text)).toEqual(["draft"]);
	});
});

test.each([true, false])(
	"close waits for indexing and preserves prompt extraction (slash commands: %j)",
	async (includeSlashCommands) => {
		const config = { ...defaultConfig, history: { ...defaultConfig.history, includeSlashCommands } };
		await withStore(async (store, cwd) => {
			const sessionDir = join(cwd, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "  persisted prompt  " },
					{ type: "image", mimeType: "image/png", data: "" },
					{ type: "text", text: "\n" },
					{ type: "text", text: "tail" },
				],
				timestamp: 1234,
			});
			session.appendMessage({ role: "user", content: " /command ", timestamp: 1235 });
			session.appendMessage({
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				stopReason: "stop",
				timestamp: 1235,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const sessions = await SessionManager.list(cwd, sessionDir);
			const listing = Promise.withResolvers<typeof sessions>();
			const started = Promise.withResolvers<void>();
			const list = spyOn(SessionManager, "list").mockImplementation(() => {
				started.resolve();
				return listing.promise;
			});
			let closing: Promise<void> | undefined;
			try {
				await store.listStashes(cwd);
				store.refreshSoon(cwd, config);
				await started.promise;
				let closed = false;
				closing = store.close().then(() => {
					closed = true;
				});
				await Promise.resolve();
				expect(closed).toBe(false);
				listing.resolve(sessions);
				await closing;
				const context = { cwd, sessionManager: SessionManager.inMemory(cwd) };
				const history = await store.listHistory(context, config);
				const live = store
					.currentPrompts({ cwd, sessionManager: session }, config)
					.sort((a, b) => b.timestamp - a.timestamp);
				expect(history).toEqual(live);
				expect(history.map((item) => item.text)).toEqual(
					includeSlashCommands ? ["/command", "persisted prompt\ntail"] : ["persisted prompt\ntail"],
				);
				expect(history.at(-1)?.hasImages).toBe(true);
				expect(store.branchPrompts({ sessionManager: session }, config)).toEqual(
					live.map((item) => item.text).reverse(),
				);
			} finally {
				listing.resolve(sessions);
				await closing;
				list.mockRestore();
			}
		});
	},
);

test("stashes created in the same millisecond are listed newest first", async () => {
	await withStore(async (store, cwd) => {
		const now = spyOn(Date, "now").mockReturnValue(1000);
		try {
			await store.insert("first", cwd);
			await store.insert("second", cwd);
			expect((await store.listStashes(cwd)).map((item) => item.text)).toEqual(["second", "first"]);
		} finally {
			now.mockRestore();
		}
	});
});

test("malformed persisted content cannot hide valid prompt blocks", async () => {
	await withStore(async (store, cwd) => {
		const path = join(cwd, "session.jsonl");
		writeFileSync(
			path,
			`${[
				{ type: "session", version: 3, id: "test-session", timestamp: "2026-01-01T00:00:00Z", cwd },
				{
					type: "message",
					id: "entry",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					message: {
						role: "user",
						timestamp: 1,
						content: [null, 3, { type: "text", text: 42 }, { type: "text", text: " valid " }, { type: "image" }],
					},
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = SessionManager.open(path);
		expect(store.currentPrompts({ cwd, sessionManager }, defaultConfig)).toMatchObject([
			{ text: "valid", hasImages: true },
		]);
		expect(store.branchPrompts({ sessionManager }, defaultConfig)).toEqual(["valid"]);
	});
});

test("a repeated watcher cleanup preserves later subscriptions", async () => {
	await withStore(async (store, cwd) => {
		const list = spyOn(SessionManager, "list").mockResolvedValue([]);
		const stop = store.watch(cwd, () => {});
		stop();
		let completed = false;
		const stopNext = store.watch(cwd, (progress) => {
			if (progress === undefined) completed = true;
		});
		try {
			stop();
			store.refreshSoon(cwd, defaultConfig);
			await store.close();
			expect(completed).toBe(true);
		} finally {
			stopNext();
			list.mockRestore();
		}
	});
});
