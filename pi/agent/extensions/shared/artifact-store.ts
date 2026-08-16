// Predecessor: a SQLite store behind a Rust binary, ~10 ms per call to build a full-text index for one now-deleted search tool.
// IDs are session-local integers, not sha256: 64 hex characters cost 16 to 21 tokens, `artifact://12` costs one to three.
// Layout tracks the session file: `.../<ts>_<sessionId>.jsonl` beside `.../<ts>_<sessionId>/12.exec_command.log`. The reader matches only the `<id>.` prefix.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveResourcePath, safeResourceSegment } from "./resources.ts";

// 8 MiB of text is over two million tokens. Above this the read fails with the backing path, so the caller brings its own bound.
export const ARTIFACT_MAX_INLINE_BYTES = 8 * 1024 * 1024;

export interface ResolvedArtifact {
	id: string;
	/** Absent for a session with no file on disk, where storage is memory. */
	path?: string;
	size: number;
	toolType: string;
}

export function artifactsDirForSessionFile(sessionFile: string): string {
	return sessionFile.replace(/\.jsonl$/i, "");
}

const ARTIFACT_FILE = /^(\d+)\.(.*)\.log$/;

export class ArtifactStore {
	readonly dir: string | undefined;
	#nextId = 0;
	#initPromise: Promise<void> | undefined;
	readonly #memory = new Map<string, { text: string; toolType: string }>();

	constructor(dir?: string) {
		this.dir = dir;
	}

	// Memoise the promise, not a boolean: the seed scan yields at `readdir`, so two racing mints would reseed alike and hand out one id twice.
	async #ready(): Promise<void> {
		this.#initPromise ??= this.#seed();
		await this.#initPromise;
	}

	async #seed(): Promise<void> {
		let maxId = -1;
		for (const name of await this.#listFiles()) {
			const match = ARTIFACT_FILE.exec(name);
			if (match) maxId = Math.max(maxId, Number.parseInt(match[1]!, 10));
		}
		this.#nextId = maxId + 1;
	}

	async #listFiles(): Promise<string[]> {
		if (!this.dir) return [...this.#memory.keys()].map((id) => `${id}.${this.#memory.get(id)!.toolType}.log`);
		try {
			return await readdir(this.dir);
		} catch {
			// A session that has never spilled has no directory yet. Allocation starts from 0.
			return [];
		}
	}

	/** Store `text` and return its id. Never throws: the caller is midway through returning a truncated result, so a broken store costs only the recovery pointer. */
	async mint(text: string, toolType: string): Promise<string | undefined> {
		try {
			await this.#ready();
			const id = String(this.#nextId++);
			const name = safeResourceSegment(toolType, "tool");
			if (!this.dir) {
				this.#memory.set(id, { text, toolType: name });
				return id;
			}
			// `safeResourceSegment` stops a tool named `../../etc/passwd` from naming the file; `resolveResourcePath` contains a bug in it to a lost artifact.
			const path = resolveResourcePath(this.dir, `${id}.${name}.log`, `artifact://${id}`);
			await mkdir(this.dir, { recursive: true });
			await writeFile(path, text, "utf8");
			return id;
		} catch {
			return undefined;
		}
	}
	/** Replace an existing artifact while a process drain adds output. */
	async replace(id: string, text: string): Promise<boolean> {
		try {
			if (!this.dir) {
				const entry = this.#memory.get(id);
				if (!entry) return false;
				this.#memory.set(id, { ...entry, text });
				return true;
			}
			const artifact = await this.resolve(id);
			if (!artifact?.path) return false;
			await writeFile(artifact.path, text, "utf8");
			return true;
		} catch {
			return false;
		}
	}

	async resolve(id: string): Promise<ResolvedArtifact | undefined> {
		if (!/^\d+$/.test(id)) return undefined;
		if (!this.dir) {
			const entry = this.#memory.get(id);
			return entry ? { id, size: Buffer.byteLength(entry.text, "utf8"), toolType: entry.toolType } : undefined;
		}
		const name = (await this.#listFiles()).find((file) => file.startsWith(`${id}.`));
		if (!name) return undefined;
		const path = join(this.dir, name);
		const info = await stat(path);
		if (!info.isFile()) return undefined;
		return { id, path, size: info.size, toolType: ARTIFACT_FILE.exec(name)?.[2] ?? "tool" };
	}

	async read(artifact: ResolvedArtifact): Promise<string> {
		if (artifact.size > ARTIFACT_MAX_INLINE_BYTES) {
			const where = artifact.path ? `: ${artifact.path}` : "";
			throw new Error(
				`Artifact ${artifact.id} is ${artifact.size} bytes, over the ${ARTIFACT_MAX_INLINE_BYTES} byte inline limit. ` +
					`Read a range of it, or search it, or use the backing file${where}`,
			);
		}
		if (!artifact.path) return this.#memory.get(artifact.id)?.text ?? "";
		return await readFile(artifact.path, "utf8");
	}

	async listIds(): Promise<string[]> {
		const ids: number[] = [];
		for (const name of await this.#listFiles()) {
			const match = ARTIFACT_FILE.exec(name);
			if (match) ids.push(Number.parseInt(match[1]!, 10));
		}
		return ids.sort((left, right) => left - right).map(String);
	}
}

// The minter and the resource provider must share one counter per session, and pi's loader gives each extension its own copy of this module. Key by storage location on a global symbol.
const ARTIFACT_STORES = Symbol.for("agents.artifactStores");
const storeState = globalThis as typeof globalThis & Record<symbol, Map<string, ArtifactStore> | undefined>;
const stores = storeState[ARTIFACT_STORES] ?? new Map<string, ArtifactStore>();
storeState[ARTIFACT_STORES] = stores;

export interface ArtifactSession {
	sessionFile?: string;
	sessionId?: string;
}

export function artifactStoreFor(session: ArtifactSession): ArtifactStore {
	const dir = session.sessionFile ? artifactsDirForSessionFile(session.sessionFile) : undefined;
	const key = dir ?? `memory:${safeResourceSegment(session.sessionId ?? "default", "default")}`;
	const existing = stores.get(key);
	if (existing) return existing;
	const store = new ArtifactStore(dir);
	stores.set(key, store);
	return store;
}
