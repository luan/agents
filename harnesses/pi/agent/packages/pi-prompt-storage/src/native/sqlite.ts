import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type SqliteParameter = string | number | bigint | null;

interface SqliteRunResult {
	lastInsertRowid: number | bigint;
}

interface SqliteStatement {
	run(...params: SqliteParameter[]): SqliteRunResult;
	get(...params: SqliteParameter[]): Record<string, unknown> | null | undefined;
	all(...params: SqliteParameter[]): readonly Record<string, unknown>[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

type DatabaseConstructor = new (path: string) => SqliteDatabase;

/** Bun and Node expose the same small synchronous API used by this extension. */
export function openSqlite(path: string): SqliteDatabase {
	if (process.versions.bun) {
		return new (require("bun:sqlite") as { Database: DatabaseConstructor }).Database(path);
	}
	return new (require("node:sqlite") as { DatabaseSync: DatabaseConstructor }).DatabaseSync(path);
}
