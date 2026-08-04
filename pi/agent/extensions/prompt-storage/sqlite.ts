import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface SqliteRunResult {
	lastInsertRowid: number | bigint;
	changes: number | bigint;
}

interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

type DatabaseCtor = new (path: string) => SqliteDatabase;

/**
 * Bun has no `node:sqlite` — a static import of it makes this whole extension fail to load there,
 * so the module is picked at runtime instead. `bun:sqlite`'s Database and node's DatabaseSync agree
 * on the exec/prepare/run/get/all surface this extension uses; they differ only in that node
 * returns `undefined` for a missing row where Bun returns `null`, and every caller here treats the
 * result as truthy-or-absent.
 */
export function openSqlite(path: string): SqliteDatabase {
	if (process.versions.bun) {
		return new (require("bun:sqlite") as { Database: DatabaseCtor }).Database(path);
	}
	return new (require("node:sqlite") as { DatabaseSync: DatabaseCtor }).DatabaseSync(path);
}
