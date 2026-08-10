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
type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
	};
};

type RestoredSnapshot = {
	path: string;
	tag: string;
	lines: Set<number>;
	synthetic: Set<number>;
	searchOutput: boolean;
};

function collectSessionSnapshots(entries: readonly SessionEntryLike[]): Map<string, RestoredSnapshot> {
	const snapshots = new Map<string, RestoredSnapshot>();
	const headerPattern = /^\[([^\]\n]+)#([0-9A-Fa-f]{4})\]\s*$/;
	const rowPattern = /^(\*| )?([1-9]\d*):/;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		for (const content of entry.message.content ?? []) {
			if (content.type !== "text" || typeof content.text !== "string") continue;
			let current: RestoredSnapshot | undefined;
			for (const line of content.text.split("\n")) {
				const header = headerPattern.exec(line.trim());
				if (header) {
					const key = `${header[1]}#${header[2].toUpperCase()}`;
					current = snapshots.get(key) ?? {
						path: header[1]!,
						tag: header[2]!.toUpperCase(),
						lines: new Set(),
						synthetic: new Set(),
						searchOutput: false,
					};
					snapshots.set(key, current);
					continue;
				}
				if (!current) continue;
				const row = rowPattern.exec(line);
				if (!row) continue;
				const lineNumber = Number(row[2]);
				current.lines.add(lineNumber);
				if (row[1] === "*") current.searchOutput = true;
				if (row[1] === " ") current.synthetic.add(lineNumber);
			}
		}
	}
	return snapshots;
}

export async function restoreHashlineSnapshots(
	snapshots: InMemorySnapshotStore,
	cwd: string,
	entries: readonly SessionEntryLike[],
): Promise<void> {
	for (const restored of collectSessionSnapshots(entries).values()) {
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(restored.path)) continue;
		const path = absolutePath(cwd, restored.path);
		try {
			const info = await stat(path);
			if (info.size > SNAPSHOT_MAX_BYTES) continue;
			const { text } = stripBom(await readFile(path, "utf-8"));
			const observedLines = restored.searchOutput
				? {
						explicit: [...restored.lines].filter((line) => !restored.synthetic.has(line)),
						synthetic: restored.synthetic,
					}
				: restored.lines.size > 0
					? [...restored.lines]
					: "all";
			const candidateStore = new InMemorySnapshotStore();
			const candidate = recordHashlineSnapshot(candidateStore, path, text, observedLines);
			if (candidate === restored.tag) snapshots.record(path, text, observedLines);
		} catch {
			// The file may have been deleted or moved since the session was saved.
		}
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
