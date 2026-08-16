import type { FileOp } from "./types";

export interface PreflightWriteOptions {
	fileOp?: FileOp;
}
/**
 * Result returned by {@link Filesystem.writeText}. The patcher echoes back
 * `text` so adapters that transform on serialization (e.g. notebooks) can
 * report what actually landed on disk.
 */
export interface WriteResult {
	/** Final text that was persisted. May differ from the input if the FS transformed it. */
	text: string;
}

/**
 * ENOENT-like error thrown by {@link Filesystem.readText} when a path is
 * missing. Carrying a `code` property keeps the contract compatible with
 * `node:fs` callers that already check `err.code === "ENOENT"`.
 */
export class NotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(path: string, cause?: unknown) {
		super(`File not found: ${path}`);
		this.name = "NotFoundError";
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

/** Type guard for {@link NotFoundError} and structurally-compatible errors. */
export function isNotFound(error: unknown): boolean {
	if (error instanceof NotFoundError) return true;
	if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true;
	return false;
}

/**
 * Abstract storage backend the {@link Patcher} reads from and writes to.
 * Subclass for new backends; the package ships {@link InMemoryFilesystem} and
 * {@link NodeFilesystem} for the most common cases.
 *
 * Implementations work with raw text — the patcher handles BOM stripping and
 * line-ending normalization itself. `readText` MUST throw {@link
 * NotFoundError} (or any error for which {@link isNotFound} returns true)
 * when the path doesn't exist; that's how the patcher detects a create-vs-
 * update.
 */
export abstract class Filesystem {
	/** Read the file's full text content. Throw on missing file. */
	abstract readText(path: string): Promise<string>;

	/** Validate that path and any file operation are writable before commit. */
	async preflightWrite(_path: string, _options?: PreflightWriteOptions): Promise<void> {}

	/** Persist `content` at `path`. Returns the actual final text that was written. */
	abstract writeText(path: string, content: string): Promise<WriteResult>;

	async delete(path: string): Promise<void> {
		throw new Error(`Filesystem does not support delete: ${path}`);
	}

	async move(from: string, to: string, _content?: string): Promise<void> {
		throw new Error(`Filesystem does not support move: ${from} -> ${to}`);
	}

	/** Return true when the path exists and can be read. Default: probe via {@link readText}. */
	async exists(path: string): Promise<boolean> {
		try {
			await this.readText(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	/**
	 * Canonical path used as a key by external caches (e.g. snapshot
	 * stores). The default is identity; override to return an absolute or
	 * otherwise canonicalised path so producers and consumers of cached
	 * snapshots agree on the key without each having to redo the resolution.
	 */
	canonicalPath(path: string): string {
		return path;
	}
}

/**
 * In-memory {@link Filesystem}. Useful for tests, sandboxes, dry-runs, and as
 * a building block for stacked adapters (e.g. an LRU layer on top).
 */
export class InMemoryFilesystem extends Filesystem {
	#files = new Map<string, string>();

	constructor(initial?: Iterable<readonly [string, string]>) {
		super();
		if (initial) {
			for (const [path, content] of initial) this.#files.set(path, content);
		}
	}

	async readText(path: string): Promise<string> {
		const text = this.#files.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		this.#files.set(path, content);
		return { text: content };
	}

	override async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	/** Synchronous helper for setting up fixtures without awaiting. */
	set(path: string, content: string): void {
		this.#files.set(path, content);
	}

	/** Synchronous helper for inspecting state without awaiting. */
	get(path: string): string | undefined {
		return this.#files.get(path);
	}

	override async delete(path: string): Promise<void> {
		if (!this.#files.delete(path)) throw new NotFoundError(path);
	}

	override async move(from: string, to: string, content?: string): Promise<void> {
		const current = this.#files.get(from);
		if (current === undefined) throw new NotFoundError(from);
		this.#files.set(to, content ?? current);
		this.#files.delete(from);
	}

	/** Wipe all entries. */
	clear(): void {
		this.#files.clear();
	}

	/** Iterate `[path, content]` pairs. */
	entries(): IterableIterator<[string, string]> {
		return this.#files.entries();
	}
}
