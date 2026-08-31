import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSqlite, type SqliteDatabase } from "../native/sqlite.ts";
import type { IndexProgress, PromptItem, PromptStorageConfig } from "../core/model.ts";

function contentBlocks(value: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((part): part is Record<string, unknown> => part !== null && typeof part === "object")
		: [];
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value.trim();
	return contentBlocks(value)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => String(part.text).trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function containsImage(value: unknown): boolean {
	return contentBlocks(value).some((part) => part.type === "image");
}

function timestamp(value: unknown, fallback: number): number {
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

function slashCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
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

	private async database(): Promise<SqliteDatabase> {
		if (this.db) return this.db;
		const path = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "prompt-storage.sqlite");
		await mkdir(dirname(path), { recursive: true });
		this.db = openSqlite(path);
		this.db.exec(`
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
		return this.db;
	}

	async insert(text: string, cwd: string): Promise<number> {
		const result = (await this.database())
			.prepare("INSERT INTO stashes (text, cwd, created_at) VALUES (?, ?, ?)")
			.run(text, cwd, Date.now());
		return Number(result.lastInsertRowid);
	}

	async remove(id: number): Promise<void> {
		(await this.database()).prepare("DELETE FROM stashes WHERE id = ?").run(id);
	}

	async listStashes(cwd: string): Promise<PromptItem[]> {
		return (await this.database())
			.prepare("SELECT id, text, cwd, created_at FROM stashes WHERE cwd = ? ORDER BY created_at DESC")
			.all(cwd)
			.map((row) => itemFromRow(row, "stash"));
	}

	currentPrompts(ctx: ExtensionContext, config: PromptStorageConfig): PromptItem[] {
		const sessionPath = ctx.sessionManager.getSessionFile();
		if (!sessionPath) return [];
		const sessionName = ctx.sessionManager.getSessionName() ?? undefined;
		return ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const text = textContent(entry.message.content);
			if (!text || (!config.history.includeSlashCommands && slashCommand(text))) return [];
			return [
				{
					kind: "history",
					id: entry.id,
					text,
					timestamp: timestamp(entry.message.timestamp, timestamp(entry.timestamp, Date.now())),
					cwd: ctx.cwd,
					sessionPath,
					sessionName,
					hasImages: containsImage(entry.message.content),
				},
			];
		});
	}

	branchPrompts(ctx: ExtensionContext, config: PromptStorageConfig): string[] {
		return ctx.sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const text = textContent(entry.message.content);
			return text && (config.history.includeSlashCommands || !slashCommand(text)) ? [text] : [];
		});
	}

	async listHistory(ctx: ExtensionContext, config: PromptStorageConfig): Promise<PromptItem[]> {
		const rows = (await this.database())
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
			if (listeners.size === 0) this.listeners.delete(cwd);
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
		this.db?.close();
		this.db = undefined;
		this.refreshes.clear();
		this.progressState.clear();
	}

	private setProgress(cwd: string, progress: IndexProgress): void {
		this.progressState.set(cwd, progress);
		for (const listener of this.listeners.get(cwd) ?? []) listener(progress);
	}

	private async refresh(cwd: string, config: PromptStorageConfig): Promise<void> {
		const database = await this.database();
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
					const text = textContent(entry.message.content);
					if (!text || (!config.history.includeSlashCommands && slashCommand(text))) continue;
					insert.run(
						session.path,
						entry.id,
						text,
						session.cwd,
						session.name ?? null,
						timestamp(entry.message.timestamp, timestamp(entry.timestamp, modifiedMs)),
						containsImage(entry.message.content) ? 1 : 0,
						searchText(text, session.name ?? undefined),
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
