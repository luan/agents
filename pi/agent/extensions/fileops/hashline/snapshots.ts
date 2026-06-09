/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag fingerprints the whole normalized file text. Producers
 * (typically `read`, `search`, and successful `edit`) record full text; the
 * patcher resolves a tag back to that file version and verifies or recovers
 * against it. Partial outputs may display only selected lines, but their tag is
 * still a whole-file tag.
 */

/** One full-file version observed at a point in time. */
export class Snapshot {
	readonly fullText: string;
	readonly recordedAt: number;

	constructor(
		readonly path: string,
		text: string,
		readonly hash: string,
		recordedAt: number = Date.now(),
	) {
		this.fullText = text;
		this.recordedAt = recordedAt;
	}

	get(lineNumber: number): string | undefined {
		return this.fullText.split("\n")[lineNumber - 1];
	}

	*entries(): IterableIterator<[number, string]> {
		const lines = this.fullText.split("\n");
		for (let index = 0; index < lines.length; index++) yield [index + 1, lines[index] ?? ""];
	}

	matchesLiveFile(currentLines: readonly string[]): boolean {
		return this.fullText === currentLines.join("\n");
	}
}

/**
 * Storage seam for full-file snapshots. Hashline section tags are opaque store
 * values; without the store that minted them they carry no authority.
 */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Recorded version for `path` whose tag equals `hash`, or `null`. */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/** Record the full normalized text of `path` and return its tag. */
	abstract record(path: string, fullText: string): string;

	/** Drop snapshots belonging to a single path. */
	abstract invalidate(path: string): void;

	/** Drop every snapshot. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
	maxVersionsPerPath?: number;
}

function normalizeFileHashText(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

function computeFileHash(text: string): string {
	const normalized = normalizeFileHashText(text);
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index++) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return (hash & 0xffff).toString(16).padStart(4, "0").toUpperCase();
}

function touchPathOrder(order: string[], path: string, maxPaths: number): string[] {
	const existing = order.indexOf(path);
	if (existing !== -1) order.splice(existing, 1);
	order.unshift(path);
	const evicted = order.splice(maxPaths);
	return evicted;
}

/**
 * In-memory {@link SnapshotStore} with per-path LRU and a short version history.
 * Re-recording identical content reuses its content tag and promotes that
 * version to the path head.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions = new Map<string, Snapshot[]>();
	readonly #pathOrder: string[] = [];
	readonly #maxPaths: number;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		const history = this.#versions.get(path);
		if (!history) return null;
		for (const evicted of touchPathOrder(this.#pathOrder, path, this.#maxPaths)) this.#versions.delete(evicted);
		return history[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const history = this.#versions.get(path);
		if (!history) return null;
		for (const evicted of touchPathOrder(this.#pathOrder, path, this.#maxPaths)) this.#versions.delete(evicted);
		const upper = hash.toUpperCase();
		return history.find((snapshot) => snapshot.hash === upper) ?? null;
	}

	record(path: string, fullText: string): string {
		const hash = computeFileHash(fullText);
		const history = this.#versions.get(path) ?? [];
		const existing = history.find((snapshot) => snapshot.hash === hash);
		if (existing) {
			this.#versions.set(path, [existing, ...history.filter((snapshot) => snapshot !== existing)]);
			for (const evicted of touchPathOrder(this.#pathOrder, path, this.#maxPaths)) this.#versions.delete(evicted);
			return hash;
		}

		const snapshot = new Snapshot(path, fullText, hash);
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		for (const evicted of touchPathOrder(this.#pathOrder, path, this.#maxPaths)) this.#versions.delete(evicted);
		return hash;
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
		const existing = this.#pathOrder.indexOf(path);
		if (existing !== -1) this.#pathOrder.splice(existing, 1);
	}

	clear(): void {
		this.#versions.clear();
		this.#pathOrder.length = 0;
	}
}
