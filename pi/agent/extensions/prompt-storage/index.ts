import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	formatStashHudLines,
	type IndexProgress,
	installPromptStorageEditor,
	openPromptPicker,
	type PromptItem,
	type PromptKind,
	restackPromptStashHud,
	setStashHud,
	shutdownPromptStoragePresentation,
	sourceLabel,
} from "./presentation";
import { openSqlite, type SqliteDatabase } from "./sqlite";

interface Config {
	enabled: boolean;
	shortcuts: {
		stash: string;
		pop: string;
		history: string;
	};
	history: {
		includeSlashCommands: boolean;
		maxResults: number;
	};
	picker: {
		maxVisible: number;
		enterAction: "apply" | "pop";
	};
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(extensionDir, "config.json");
const dbPath = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "prompt-storage.sqlite");

const defaultConfig: Config = {
	enabled: true,
	shortcuts: {
		stash: "ctrl+s",
		pop: "ctrl+shift+s",
		history: "ctrl+r",
	},
	history: {
		includeSlashCommands: true,
		maxResults: 120,
	},
	picker: {
		maxVisible: 10,
		enterAction: "apply",
	},
};

let db: SqliteDatabase | undefined;
const historyRefreshes = new Map<string, Promise<void>>();
const historyRefreshesAt = new Map<string, number>();
const historyRefreshIntervalMs = 30_000;
const historyIndexProgress = new Map<string, IndexProgress>();
const historyIndexListeners = new Map<string, Set<(progress: IndexProgress | undefined) => void>>();

function setHistoryIndexProgress(cwd: string, progress: IndexProgress | undefined): void {
	if (progress) historyIndexProgress.set(cwd, progress);
	else historyIndexProgress.delete(cwd);
	for (const listener of historyIndexListeners.get(cwd) ?? []) listener(progress);
}

function watchHistoryIndex(cwd: string, listener: (progress: IndexProgress | undefined) => void): () => void {
	const listeners = historyIndexListeners.get(cwd) ?? new Set();
	listeners.add(listener);
	historyIndexListeners.set(cwd, listeners);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) historyIndexListeners.delete(cwd);
	};
}

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
		return {
			...defaultConfig,
			...parsed,
			shortcuts: { ...defaultConfig.shortcuts, ...parsed.shortcuts },
			history: { ...defaultConfig.history, ...parsed.history },
			picker: { ...defaultConfig.picker, ...parsed.picker },
		};
	} catch {
		return defaultConfig;
	}
}

async function openDb(): Promise<SqliteDatabase> {
	if (db) return db;
	await mkdir(dirname(dbPath), { recursive: true });
	db = openSqlite(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS stashes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			cwd TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS session_index (
			session_path TEXT PRIMARY KEY,
			modified_ms INTEGER NOT NULL,
			indexed_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS history_prompts (
			session_path TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			text TEXT NOT NULL,
			cwd TEXT NOT NULL,
			session_name TEXT,
			prompt_ts INTEGER NOT NULL,
			has_images INTEGER NOT NULL DEFAULT 0,
			search_text TEXT NOT NULL,
			PRIMARY KEY (session_path, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_stashes_created_at ON stashes(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_history_prompt_ts ON history_prompts(prompt_ts DESC);
	`);
	return db;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type?: unknown; text?: unknown } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text).trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function hasImages(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.some((block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "image")
	);
}

function timestampMs(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = new Date(value).getTime();
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function preview(value: string, max = 90): string {
	const compact = compactWhitespace(value);
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function isSlashCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

function buildSearchText(text: string, sessionName?: string): string {
	return `${text}\n${sessionName ?? ""}`.toLowerCase();
}

function makeItemSearchText(item: Omit<PromptItem, "searchText">): string {
	return buildSearchText(item.text, item.sessionName);
}

function rowString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function rowNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	return typeof value === "number" ? value : Number(value);
}

async function insertStash(text: string, cwd: string): Promise<number> {
	const database = await openDb();
	const result = database
		.prepare("INSERT INTO stashes (text, cwd, created_at) VALUES (?, ?, ?)")
		.run(text, cwd, Date.now());
	return Number(result.lastInsertRowid);
}

async function deleteStash(id: number): Promise<void> {
	const database = await openDb();
	database.prepare("DELETE FROM stashes WHERE id = ?").run(id);
}

async function listStashes(cwd?: string): Promise<PromptItem[]> {
	const database = await openDb();
	const statement =
		cwd === undefined
			? database.prepare("SELECT id, text, cwd, created_at FROM stashes ORDER BY created_at DESC")
			: database.prepare("SELECT id, text, cwd, created_at FROM stashes WHERE cwd = ? ORDER BY created_at DESC");
	return statement.all(...(cwd === undefined ? [] : [cwd])).map((row) => {
		const record = row as Record<string, unknown>;
		const item: Omit<PromptItem, "searchText"> = {
			kind: "stash",
			id: rowNumber(record, "id"),
			text: rowString(record, "text"),
			cwd: rowString(record, "cwd"),
			timestamp: rowNumber(record, "created_at"),
		};
		return { ...item, searchText: makeItemSearchText(item) };
	});
}

async function updateStashHud(ctx: ExtensionContext): Promise<void> {
	const stashes = await listStashes(ctx.cwd);
	setStashHud(ctx, stashes.length > 0 ? formatStashHudLines(stashes) : []);
}

function currentSessionPrompts(ctx: ExtensionContext, config: Config): PromptItem[] {
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!sessionPath) return [];
	const sessionName = ctx.sessionManager.getSessionName();
	const records: PromptItem[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown; timestamp?: unknown };
		if (message.role !== "user") continue;
		const text = extractText(message.content);
		if (!text) continue;
		if (!config.history.includeSlashCommands && isSlashCommand(text)) continue;
		const item: Omit<PromptItem, "searchText"> = {
			kind: "history",
			id: entry.id,
			text,
			cwd: ctx.cwd,
			timestamp: timestampMs(message.timestamp, timestampMs(entry.timestamp, Date.now())),
			sessionPath,
			sessionName,
			hasImages: hasImages(message.content),
		};
		records.push({ ...item, searchText: makeItemSearchText(item) });
	}
	return records;
}
function currentBranchPrompts(ctx: ExtensionContext, config: Config): string[] {
	const prompts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user") continue;
		const text = extractText(message.content);
		if (!text || (!config.history.includeSlashCommands && isSlashCommand(text))) continue;
		prompts.push(text);
	}
	return prompts;
}

async function refreshProjectHistoryIndex(
	cwd: string,
	config: Config,
	onProgress?: (progress: IndexProgress) => void,
): Promise<void> {
	const database = await openDb();
	const sessions = await SessionManager.list(cwd, undefined, (loaded, total) =>
		onProgress?.({ phase: "sessions", loaded, total }),
	);
	let loaded = 0;
	for (const session of sessions) {
		const modifiedMs = session.modified.getTime();
		const indexed = database
			.prepare("SELECT modified_ms FROM session_index WHERE session_path = ?")
			.get(session.path) as Record<string, unknown> | undefined;
		if (indexed && rowNumber(indexed, "modified_ms") === modifiedMs) {
			loaded++;
			onProgress?.({ phase: "prompts", loaded, total: sessions.length });
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
				if (entry.type !== "message") continue;
				const message = entry.message as { role?: string; content?: unknown; timestamp?: unknown };
				if (message.role !== "user") continue;
				const text = extractText(message.content);
				if (!text) continue;
				if (!config.history.includeSlashCommands && isSlashCommand(text)) continue;
				insert.run(
					session.path,
					entry.id,
					text,
					session.cwd,
					session.name ?? null,
					timestampMs(message.timestamp, timestampMs(entry.timestamp, modifiedMs)),
					hasImages(message.content) ? 1 : 0,
					buildSearchText(text, session.name),
				);
			}
			database
				.prepare("INSERT OR REPLACE INTO session_index (session_path, modified_ms, indexed_at) VALUES (?, ?, ?)")
				.run(session.path, modifiedMs, Date.now());
			database.exec("COMMIT");
		} catch {
			try {
				database.exec("ROLLBACK");
			} catch {}
		}
		loaded++;
		onProgress?.({ phase: "prompts", loaded, total: sessions.length });
	}
}

/**
 * Refresh at most once per 30 seconds. Current-session prompts are merged live,
 * so opening the picker does not need to rescan every session each time.
 */
function refreshProjectHistorySoon(cwd: string, config: Config): void {
	if (historyRefreshes.has(cwd)) return;
	const refreshedAt = historyRefreshesAt.get(cwd) ?? 0;
	if (Date.now() - refreshedAt < historyRefreshIntervalMs) return;
	const refresh = refreshProjectHistoryIndex(cwd, config, (progress) => setHistoryIndexProgress(cwd, progress))
		.then(() => {
			historyRefreshesAt.set(cwd, Date.now());
		})
		.catch(() => {})
		.finally(() => {
			setHistoryIndexProgress(cwd, undefined);
			historyRefreshes.delete(cwd);
		});
	historyRefreshes.set(cwd, refresh);
}

async function listHistory(ctx: ExtensionContext, config: Config): Promise<PromptItem[]> {
	const database = await openDb();
	const indexed: PromptItem[] = database
		.prepare(
			"SELECT session_path, entry_id, text, cwd, session_name, prompt_ts, has_images, search_text FROM history_prompts WHERE cwd = ? ORDER BY prompt_ts DESC",
		)
		.all(ctx.cwd)
		.map((row): PromptItem => {
			const record = row as Record<string, unknown>;
			return {
				kind: "history" as const,
				id: rowString(record, "entry_id"),
				text: rowString(record, "text"),
				cwd: rowString(record, "cwd"),
				timestamp: rowNumber(record, "prompt_ts"),
				sessionPath: rowString(record, "session_path"),
				sessionName: rowString(record, "session_name") || undefined,
				hasImages: rowNumber(record, "has_images") === 1,
				searchText: buildSearchText(rowString(record, "text"), rowString(record, "session_name") || undefined),
			};
		});
	const merged = new Map<string, PromptItem>();
	for (const item of indexed.concat(currentSessionPrompts(ctx, config))) {
		const key = `${item.sessionPath ?? ""}|${item.id}|${item.text}`;
		merged.set(key, item);
	}
	return [...merged.values()].sort((a, b) => b.timestamp - a.timestamp);
}

async function autoStashCurrentEditor(ctx: ExtensionContext, replacementText: string): Promise<boolean> {
	const current = ctx.ui.getEditorText?.() ?? "";
	if (!current.trim() || current === replacementText) return false;
	await insertStash(current, ctx.cwd);
	return true;
}

async function applyItem(ctx: ExtensionContext, item: PromptItem, action: "apply" | "pop"): Promise<void> {
	const savedCurrent = await autoStashCurrentEditor(ctx, item.text);
	ctx.ui.setEditorText?.(item.text);
	if (action === "pop" && item.kind === "stash" && typeof item.id === "number") await deleteStash(item.id);
	await updateStashHud(ctx);
	const verb = action === "pop" ? "Popped" : "Applied";
	ctx.ui.notify(`${verb} ${sourceLabel(item)}${savedCurrent ? "; current draft auto-stashed" : ""}`, "info");
}

async function stashEditor(ctx: ExtensionContext): Promise<void> {
	const text = ctx.ui.getEditorText?.() ?? "";
	if (!text.trim()) {
		ctx.ui.notify("Nothing to stash — editor is empty.", "warning");
		return;
	}
	await insertStash(text, ctx.cwd);
	ctx.ui.setEditorText?.("");
	await updateStashHud(ctx);
	ctx.ui.notify(`Stashed: ${preview(text, 60)}`, "info");
}

async function pick(ctx: ExtensionContext, title: string, items: PromptItem[], config: Config, mode: PromptKind) {
	return openPromptPicker(ctx, title, items, config, mode, {
		progress: (cwd) => historyIndexProgress.get(cwd),
		watch: watchHistoryIndex,
	});
}

async function openStashPicker(ctx: ExtensionContext, config: Config): Promise<void> {
	while (true) {
		const result = await pick(ctx, "Prompt Stash", await listStashes(ctx.cwd), config, "stash");
		if (!result) return;
		if (result.action === "drop") {
			if (typeof result.item.id === "number") await deleteStash(result.item.id);
			await updateStashHud(ctx);
			ctx.ui.notify(`Dropped ${sourceLabel(result.item)}`, "info");
			continue;
		}
		await applyItem(ctx, result.item, result.action === "pop" ? "pop" : "apply");
		return;
	}
}

async function smartPop(ctx: ExtensionContext, config: Config): Promise<void> {
	const stashes = await listStashes(ctx.cwd);
	if (stashes.length === 0) {
		ctx.ui.notify("No stashes.", "info");
		return;
	}
	if (stashes.length === 1) {
		await applyItem(ctx, stashes[0]!, "pop");
		return;
	}
	await openStashPicker(ctx, config);
}

async function openHistoryPicker(ctx: ExtensionContext, config: Config): Promise<void> {
	refreshProjectHistorySoon(ctx.cwd, config);
	const result = await pick(ctx, "Prompt History", await listHistory(ctx, config), config, "history");
	if (!result) return;
	await applyItem(ctx, result.item, "apply");
}

export default function promptStorage(pi: ExtensionAPI) {
	const config = loadConfig();
	if (!config.enabled) return;
	let activeContext: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		installPromptStorageEditor(ctx, () => activeContext, config, {
			stash: stashEditor,
			pop: (current) => smartPop(current, config),
			history: (current) => openHistoryPicker(current, config),
			currentPrompts: (current) => currentBranchPrompts(current, config),
		});
		refreshProjectHistorySoon(ctx.cwd, config);
		await updateStashHud(ctx);
		restackPromptStashHud(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("message_start", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});
	// A cell's nested tool calls fire no start or end event, so a long cell left the HUD unstacked.
	pi.on("tool_execution_update", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		restackPromptStashHud(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shutdownPromptStoragePresentation(ctx);
		activeContext = undefined;
		db?.close();
		db = undefined;
	});
}
