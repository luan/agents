import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { formatHashlineHeader } from "./format.js";
import { InMemorySnapshotStore, type ObservedLines } from "./snapshots.js";

const HASHLINE_SNAPSHOT_STORE_KEY = Symbol.for("pi.fileops.hashline.snapshots");

type HashlineSnapshotGlobal = typeof globalThis & {
	[HASHLINE_SNAPSHOT_STORE_KEY]?: InMemorySnapshotStore;
};

const snapshotGlobal = globalThis as HashlineSnapshotGlobal;

function isCompatibleSnapshotStore(value: unknown): value is InMemorySnapshotStore {
	return value instanceof InMemorySnapshotStore;
}

if (!isCompatibleSnapshotStore(snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY])) {
	snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY] = new InMemorySnapshotStore();
}

export const HASHLINE_SNAPSHOTS = snapshotGlobal[HASHLINE_SNAPSHOT_STORE_KEY];

export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function recordHashlineSnapshot(path: string, fullText: string, observedLines: ObservedLines = "all"): string {
	return HASHLINE_SNAPSHOTS.record(path, normalizeToLf(fullText), observedLines);
}

export async function recordHashlineFileSnapshot(
	path: string,
	observedLines: ObservedLines = "all",
): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (info.size > SNAPSHOT_MAX_BYTES) return undefined;
		const { text } = stripBom(await readFile(path, "utf-8"));
		return recordHashlineSnapshot(path, text, observedLines);
	} catch {
		return undefined;
	}
}

export async function createHashlineEditAnchor(cwd: string, path: string): Promise<string> {
	const absolute = absolutePath(cwd, path);
	const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
	const text = normalizeToLf(rawText);
	const tag = recordHashlineSnapshot(absolute, text);
	return formatHashlineHeader(displayPath(cwd, absolute), tag);
}
