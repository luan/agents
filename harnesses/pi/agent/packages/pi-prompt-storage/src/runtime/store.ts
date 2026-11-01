import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSqlite, type SqliteDatabase } from "../native/sqlite.ts";
import type { IndexProgress, PromptItem, PromptStorageConfig } from "../core/model.ts";

type PromptContext = Pick<ExtensionContext, "cwd"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionName" | "getEntries">;
};

// type-boundary: Pi session files can contain malformed message content; promptContent validates each block.
type SessionContentBoundary = unknown;

function promptContent(
	content: SessionContentBoundary,
	includeSlashCommands: boolean,
): Pick<PromptItem, "text" | "hasImages"> | undefined {
	const blocks: readonly SessionContentBoundary[] = Array.isArray(content) ? content : [];
	const textParts = typeof content === "string" ? [content] : [];
	let hasImages = false;
	for (const block of blocks) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") textParts.push(block.text);
		if (block.type === "image") hasImages = true;
	}
	const text = textParts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n");
	if (!text || (!includeSlashCommands && text.startsWith("/"))) return undefined;
	return { text, hasImages };
}

function timestamp(value: string | number, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = new Date(value).getTime();
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function rowString(row: Record<string, unknown>, key: string): string {
	return typeof row[key] === "string" ? String(row[key]) : "";
}

function rowNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	return typeof value === "number" ? value : Number(value);
}

function searchText(text: string, sessionName?: string): string {
	return `${text}\n${sessionName ?? ""}`.toLowerCase();
}

function itemFromRow(row: Record<string, unknown>, kind: PromptItem["kind"]): PromptItem {
	return {
		kind,
		id: kind === "stash" ? rowNumber(row, "id") : rowString(row, "entry_id"),
		text: rowString(row, "text"),
		timestamp: rowNumber(row, kind === "stash" ? "created_at" : "prompt_ts"),
		cwd: rowString(row, "cwd"),
		...(kind === "history"
			? {
					sessionPath: rowString(row, "session_path"),
					sessionName: rowString(row, "session_name") || undefined,
					hasImages: rowNumber(row, "has_images") === 1,
				}
			: {}),
	};
}

export class PromptStorageStore {
	private db: SqliteDatabase | undefined;
	private readonly refreshes = new Map<string, Promise<void>>();
	private readonly refreshedAt = new Map<string, number>();
	private readonly progressState = new Map<string, IndexProgress>();
	private readonly listeners = new Map<string, Set<(progress: IndexProgress | undefined) => void>>();

	private readonly refreshIntervalMs = 30_000;

	private database(): SqliteDatabase {
		if (this.db) return this.db;
		const path = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "prompt-storage.sqlite");
		mkdirSync(dirname(path), { recursive: true });
		const database = openSqlite(path);
		try {
			database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS stashes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS session_index (session_path TEXT PRIMARY KEY, modified_ms INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS history_prompts (
				session_path TEXT NOT NULL, entry_id TEXT NOT NULL, text TEXT NOT NULL, cwd TEXT NOT NULL,
				session_name TEXT, prompt_ts INTEGER NOT NULL, has_images INTEGER NOT NULL DEFAULT 0,
				search_text TEXT NOT NULL, PRIMARY KEY (session_path, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_stashes_created_at ON stashes(created_at DESC);
			CREATE INDEX IF NOT EXISTS idx_history_prompt_ts ON history_prompts(prompt_ts DESC);
		`);
		} catch (error) {
			database.close();
			throw error;
		}
		this.db = database;
		return database;
	}

	async insert(text: string, cwd: string): Promise<number> {
		const result = this.database()
			.prepare("INSERT INTO stashes (text, cwd, created_at) VALUES (?, ?, ?)")
			.run(text, cwd, Date.now());
		return Number(result.lastInsertRowid);
	}

	async remove(id: number): Promise<void> {
		this.database().prepare("DELETE FROM stashes WHERE id = ?").run(id);
	}

	async listStashes(cwd: string): Promise<PromptItem[]> {
		return this.database()
			.prepare("SELECT id, text, cwd, created_at FROM stashes WHERE cwd = ? ORDER BY created_at DESC, id DESC")
			.all(cwd)
			.map((row) => itemFromRow(row, "stash"));
	}

	currentPrompts(ctx: PromptContext, config: PromptStorageConfig): PromptItem[] {
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (!sessionPath) return [];
		const sessionName = ctx.sessionManager.getSessionName() ?? undefined;
		return ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const prompt = promptContent(entry.message.content, config.history.includeSlashCommands);
			if (!prompt) return [];
			return [
				{
					kind: "history",
					id: entry.id,
					...prompt,
					timestamp: timestamp(entry.message.timestamp, timestamp(entry.timestamp, Date.now())),
					cwd: ctx.cwd,
					sessionPath,
					sessionName,
				},
			];
		});
	}

	branchPrompts(
		ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch"> },
		config: PromptStorageConfig,
	): string[] {
		return ctx.sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const prompt = promptContent(entry.message.content, config.history.includeSlashCommands);
			return prompt ? [prompt.text] : [];
		});
	}

	async listHistory(ctx: PromptContext, config: PromptStorageConfig): Promise<PromptItem[]> {
		const rows = this.database()
			.prepare(
				"SELECT session_path, entry_id, text, cwd, session_name, prompt_ts, has_images FROM history_prompts WHERE cwd = ? ORDER BY prompt_ts DESC",
			)
			.all(ctx.cwd);
		const merged = new Map<string, PromptItem>();
		for (const item of rows.map((row) => itemFromRow(row, "history")).concat(this.currentPrompts(ctx, config))) {
			merged.set(`${item.sessionPath ?? ""}|${item.id}|${item.text}`, item);
		}
		return [...merged.values()].sort((left, right) => right.timestamp - left.timestamp);
	}

	watch(cwd: string, listener: (progress: IndexProgress | undefined) => void): () => void {
		const listeners = this.listeners.get(cwd) ?? new Set();
		listeners.add(listener);
		this.listeners.set(cwd, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && this.listeners.get(cwd) === listeners) this.listeners.delete(cwd);
		};
	}

	getProgress(cwd: string): IndexProgress | undefined {
		return this.progressState.get(cwd);
	}

	refreshSoon(cwd: string, config: PromptStorageConfig): void {
		if (this.refreshes.has(cwd) || Date.now() - (this.refreshedAt.get(cwd) ?? 0) < this.refreshIntervalMs) return;
		const refresh = this.refresh(cwd, config)
			.then(() => {
				this.refreshedAt.set(cwd, Date.now());
			})
			.catch(() => undefined)
			.finally(() => {
				this.progressState.delete(cwd);
				for (const listener of this.listeners.get(cwd) ?? []) listener(undefined);
				this.refreshes.delete(cwd);
			});
		this.refreshes.set(cwd, refresh);
	}

	async close(): Promise<void> {
		await Promise.all(this.refreshes.values());
		this.db?.close();
		this.db = undefined;
		this.refreshedAt.clear();
		this.progressState.clear();
	}

	private setProgress(cwd: string, progress: IndexProgress): void {
		this.progressState.set(cwd, progress);
		for (const listener of this.listeners.get(cwd) ?? []) listener(progress);
	}

	private async refresh(cwd: string, config: PromptStorageConfig): Promise<void> {
		const database = this.database();
		const sessions = await SessionManager.list(cwd, undefined, (loaded, total) =>
			this.setProgress(cwd, { phase: "sessions", loaded, total }),
		);
		for (let index = 0; index < sessions.length; index++) {
			const session = sessions[index]!;
			const modifiedMs = session.modified.getTime();
			const indexed = database
				.prepare("SELECT modified_ms FROM session_index WHERE session_path = ?")
				.get(session.path);
			if (indexed && rowNumber(indexed, "modified_ms") === modifiedMs) {
				this.setProgress(cwd, { phase: "prompts", loaded: index + 1, total: sessions.length });
				continue;
			}
			try {
				const manager = SessionManager.open(session.path);
				database.exec("BEGIN");
				database.prepare("DELETE FROM history_prompts WHERE session_path = ?").run(session.path);
				const insert = database.prepare(
					"INSERT OR REPLACE INTO history_prompts (session_path, entry_id, text, cwd, session_name, prompt_ts, has_images, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				);
				for (const entry of manager.getEntries()) {
					if (entry.type !== "message" || entry.message.role !== "user") continue;
					const prompt = promptContent(entry.message.content, config.history.includeSlashCommands);
					if (!prompt) continue;
					insert.run(
						session.path,
						entry.id,
						prompt.text,
						session.cwd,
						session.name ?? null,
						timestamp(entry.message.timestamp, timestamp(entry.timestamp, modifiedMs)),
						prompt.hasImages ? 1 : 0,
						searchText(prompt.text, session.name ?? undefined),
					);
				}
				database
					.prepare("INSERT OR REPLACE INTO session_index (session_path, modified_ms, indexed_at) VALUES (?, ?, ?)")
					.run(session.path, modifiedMs, Date.now());
				database.exec("COMMIT");
			} catch {
				try {
					database.exec("ROLLBACK");
				} catch {
					/* preserve the next session */
				}
			}
			this.setProgress(cwd, { phase: "prompts", loaded: index + 1, total: sessions.length });
		}
	}
}
