import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { formatHashlineHeader } from "./format.js";
import { InMemorySnapshotStore, type ObservedLines } from "./snapshots.js";

const HASHLINE_SNAPSHOT_STORES_KEY = Symbol.for("pi.fileops.hashline.snapshots.bySession");

type HashlineSnapshotGlobal = typeof globalThis & {
	[HASHLINE_SNAPSHOT_STORES_KEY]?: Map<string, InMemorySnapshotStore>;
};

const snapshotGlobal = globalThis as HashlineSnapshotGlobal;

if (!(snapshotGlobal[HASHLINE_SNAPSHOT_STORES_KEY] instanceof Map)) {
	snapshotGlobal[HASHLINE_SNAPSHOT_STORES_KEY] = new Map();
}

const SESSION_SNAPSHOT_STORES = snapshotGlobal[HASHLINE_SNAPSHOT_STORES_KEY];

export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const FALLBACK_HASHLINE_SNAPSHOT_SESSION_ID = "fallback";

export function hashlineSnapshotStoreForSession(sessionId: string): InMemorySnapshotStore {
	let store = SESSION_SNAPSHOT_STORES.get(sessionId);
	if (!store) {
		store = new InMemorySnapshotStore();
		SESSION_SNAPSHOT_STORES.set(sessionId, store);
	}
	return store;
}

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

export function recordHashlineSnapshot(
	snapshots: InMemorySnapshotStore,
	path: string,
	fullText: string,
	observedLines: ObservedLines = "all",
): string {
	return snapshots.record(path, normalizeToLf(fullText), observedLines);
}

export async function recordHashlineFileSnapshot(
	snapshots: InMemorySnapshotStore,
	path: string,
	observedLines: ObservedLines = "all",
): Promise<string | undefined> {
	try {
		const info = await stat(path);
		if (info.size > SNAPSHOT_MAX_BYTES) return undefined;
		const { text } = stripBom(await readFile(path, "utf-8"));
		return recordHashlineSnapshot(snapshots, path, text, observedLines);
	} catch {
		return undefined;
	}
}

export async function createHashlineEditAnchor(
	snapshots: InMemorySnapshotStore,
	cwd: string,
	path: string,
): Promise<string> {
	const absolute = absolutePath(cwd, path);
	const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
	const text = normalizeToLf(rawText);
	const tag = recordHashlineSnapshot(snapshots, absolute, text);
	return formatHashlineHeader(displayPath(cwd, absolute), tag);
}
