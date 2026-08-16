/**
 * Reads that must not become a byte dump.
 *
 * Four file kinds answer an unscoped `read` with something enormous and
 * useless: an archive spills its compressed bytes, a SQLite database spills a
 * B-tree, a PDF spills a binary stream, and any other binary spills whatever it
 * holds. Each of them has a cheap answer that is what the reader wanted anyway
 * — the entry list, the schema, the extracted text, the file's identity — so
 * each gets a branch here and nothing gets a framework.
 *
 * Every branch shells out to a tool that is either present or not. A missing
 * tool degrades to the binary notice rather than failing the read: the model
 * asked what is in the file, and "a 4 MB zip archive; `unzip` is not installed"
 * answers that.
 */

import { open, stat } from "node:fs/promises";
import { resolveCommand, runCommand } from "../shared/command-runner.ts";

/** Where the fileops tools look for CLI helpers, mirroring the search path used for `rg`. */
const ROUTING_SEARCH_PATHS = [
	"~/.local/bin",
	"~/.cargo/bin",
	"~/.zerobrew/bin",
	"/opt/zerobrew/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/pkg/env/global/bin",
	"/usr/bin",
	"/bin",
];

/** Entries listed before the listing itself becomes the cost it was avoiding. */
const ARCHIVE_ENTRY_LIMIT = 500;
/** Tables listed for a database. Past this the schema is the wrong tool. */
const SQLITE_TABLE_LIMIT = 200;
/** Pages converted from a PDF. The rest is reachable by converting again. */
const PDF_PAGE_LIMIT = 20;
/** Bytes sniffed for a NUL before calling a file binary. */
const BINARY_SNIFF_BYTES = 8192;

export interface RoutedRead {
	text: string;
	details: Record<string, unknown>;
}

type ArchiveKind =
	| { command: "tar"; args: (path: string) => string[] }
	| { command: "unzip"; args: (path: string) => string[] };

const TAR_LIST: ArchiveKind = { command: "tar", args: (path) => ["-tf", path] };
const TAR_GZ_LIST: ArchiveKind = { command: "tar", args: (path) => ["-tzf", path] };
const ZIP_LIST: ArchiveKind = { command: "unzip", args: (path) => ["-Z1", path] };

function archiveKind(lowerPath: string): ArchiveKind | undefined {
	if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz") || lowerPath.endsWith(".tar.bz2"))
		return TAR_GZ_LIST;
	if (lowerPath.endsWith(".tar")) return TAR_LIST;
	if (/\.(zip|jar|war|ear|apk|whl)$/.test(lowerPath)) return ZIP_LIST;
	return undefined;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readHeader(absolute: string, length: number): Promise<Buffer> {
	const file = await open(absolute, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await file.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

function capList(entries: readonly string[], limit: number, label: string): { lines: string[]; total: number } {
	const kept = entries.slice(0, limit);
	const lines = [...kept];
	if (entries.length > kept.length) {
		lines.push(`[${entries.length - kept.length} more ${label} not shown]`);
	}
	return { lines, total: entries.length };
}

async function listArchive(
	display: string,
	absolute: string,
	kind: ArchiveKind,
	cwd: string,
): Promise<RoutedRead | undefined> {
	if (!resolveCommand(kind.command, ROUTING_SEARCH_PATHS)) return undefined;
	const result = await runCommand(kind.command, kind.args(absolute), cwd, {
		allowNonZero: true,
		extraSearchPaths: ROUTING_SEARCH_PATHS,
	});
	if (result.exitCode !== 0) return undefined;
	const entries = result.stdout.split("\n").filter((entry) => entry.trim().length > 0);
	const { lines, total } = capList(entries, ARCHIVE_ENTRY_LIMIT, "entries");
	return {
		text: [`${display}: archive with ${total} entries.`, ...lines].join("\n"),
		details: { readKind: "archive", entryCount: total },
	};
}

async function describeSqlite(display: string, absolute: string, cwd: string): Promise<RoutedRead | undefined> {
	if (!resolveCommand("sqlite3", ROUTING_SEARCH_PATHS)) return undefined;
	const run = (sql: string) =>
		runCommand("sqlite3", ["-readonly", "-noheader", "-separator", "\t", absolute, sql], cwd, {
			allowNonZero: true,
			extraSearchPaths: ROUTING_SEARCH_PATHS,
		});
	const names = await run(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	if (names.exitCode !== 0) return undefined;
	const tables = names.stdout.split("\n").filter((name) => name.trim().length > 0);
	if (tables.length === 0) {
		return {
			text: `${display}: SQLite database with no user tables.`,
			details: { readKind: "sqlite", tableCount: 0 },
		};
	}
	const counted = tables.slice(0, SQLITE_TABLE_LIMIT);
	const countSql = counted
		.map((table) => `SELECT '${table.replace(/'/g, "''")}', COUNT(*) FROM "${table.replace(/"/g, '""')}"`)
		.join(" UNION ALL ");
	const counts = await run(countSql);
	const rows = counts.exitCode === 0 ? counts.stdout.split("\n").filter((row) => row.includes("\t")) : counted;
	const { lines, total } = capList(rows, SQLITE_TABLE_LIMIT, "tables");
	const schema = await run(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	return {
		text: [
			`${display}: SQLite database, ${total} ${total === 1 ? "table" : "tables"} (name, rows).`,
			...lines,
			"",
			...(schema.exitCode === 0 ? [schema.stdout.trimEnd()] : []),
		].join("\n"),
		details: { readKind: "sqlite", tableCount: total },
	};
}

async function convertPdf(display: string, absolute: string, cwd: string): Promise<RoutedRead | undefined> {
	if (!resolveCommand("pdftotext", ROUTING_SEARCH_PATHS)) return undefined;
	const result = await runCommand("pdftotext", ["-layout", "-l", String(PDF_PAGE_LIMIT), absolute, "-"], cwd, {
		allowNonZero: true,
		extraSearchPaths: ROUTING_SEARCH_PATHS,
	});
	if (result.exitCode !== 0 || result.stdout.trim().length === 0) return undefined;
	return {
		text: `${display}: text of the first ${PDF_PAGE_LIMIT} pages.\n\n${result.stdout.trimEnd()}`,
		details: { readKind: "pdf" },
	};
}

function binaryNotice(display: string, bytes: number, reason: string): RoutedRead {
	return {
		text: [
			`${display} is a ${formatBytes(bytes)} binary file (${reason}).`,
			`Read it as bytes with \`${display}:raw\`, or search it with \`search\`.`,
		].join("\n"),
		details: { readKind: "binary", bytes },
	};
}

/**
 * Answer for a file whose bytes are not text, or undefined to read it normally.
 *
 * Called only for unscoped, non-raw reads: `:raw` is the escape hatch that says
 * the caller wants the bytes, and a line selector says the caller already knows
 * the file is text.
 */
export async function routeReadByType(display: string, absolute: string, cwd: string): Promise<RoutedRead | undefined> {
	const lowerPath = absolute.toLowerCase();
	const info = await stat(absolute);

	const archive = archiveKind(lowerPath);
	if (archive) {
		const listed = await listArchive(display, absolute, archive, cwd);
		if (listed) return listed;
		return binaryNotice(display, info.size, "archive");
	}

	const header = await readHeader(absolute, BINARY_SNIFF_BYTES);
	if (header.subarray(0, 16).toString("binary").startsWith("SQLite format 3\0")) {
		const described = await describeSqlite(display, absolute, cwd);
		if (described) return described;
		return binaryNotice(display, info.size, "SQLite database; sqlite3 is not installed");
	}

	if (header.subarray(0, 5).toString("binary") === "%PDF-") {
		const converted = await convertPdf(display, absolute, cwd);
		if (converted) return converted;
		return binaryNotice(display, info.size, "PDF; pdftotext is not installed");
	}

	if (header.includes(0)) return binaryNotice(display, info.size, "contains NUL bytes");
	return undefined;
}
