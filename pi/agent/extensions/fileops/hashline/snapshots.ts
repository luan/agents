/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag fingerprints the whole normalized file text. Producers
 * (typically `read`, `search`, and successful `edit`) record full text plus
 * the line numbers that carry edit authority. Full reads authorize all lines;
 * partial reads and search results authorize only explicitly requested or
 * matched lines. Synthetic block-context lines are tracked for diagnostics but
 * do not authorize later line-numbered edits by default.
 */

type ObservedLineSet = "all" | Iterable<number>;

interface ObservedLineAuthority {
	/** Lines explicitly requested by read ranges/offsets or directly matched by search. */
	explicit: ObservedLineSet;
	/** Extra structural context lines shown to help understand the explicit lines. */
	synthetic?: Iterable<number>;
}

/** Observed-line authority for a full-file snapshot. */
export type ObservedLines = ObservedLineSet | ObservedLineAuthority;

interface NormalizedObservedLines {
	explicit: Set<number> | null;
	synthetic: Set<number>;
}

function normalizeLineSet(linesInput: ObservedLineSet): Set<number> | null {
	if (linesInput === "all") return null;
	const lines = new Set<number>();
	for (const line of linesInput) {
		if (Number.isInteger(line) && line > 0) lines.add(line);
	}
	return lines;
}

function normalizeSyntheticLines(linesInput: Iterable<number> | undefined, explicit: Set<number> | null): Set<number> {
	const lines = new Set<number>();
	if (!linesInput || explicit === null) return lines;
	for (const line of linesInput) {
		if (Number.isInteger(line) && line > 0 && !explicit.has(line)) lines.add(line);
	}
	return lines;
}

function isObservedLineAuthority(observedLines: ObservedLines): observedLines is ObservedLineAuthority {
	return typeof observedLines === "object" && observedLines !== null && "explicit" in observedLines;
}

function normalizeObservedLines(observedLines: ObservedLines): NormalizedObservedLines {
	if (isObservedLineAuthority(observedLines)) {
		const explicit = normalizeLineSet(observedLines.explicit);
		return {
			explicit,
			synthetic: normalizeSyntheticLines(observedLines.synthetic, explicit),
		};
	}
	return { explicit: normalizeLineSet(observedLines), synthetic: new Set() };
}

function mergeExplicitLines(current: Set<number> | null, incoming: Set<number> | null): Set<number> | null {
	if (current === null || incoming === null) return null;
	return new Set([...current, ...incoming]);
}

function mergeObservedLines(
	current: NormalizedObservedLines,
	incoming: NormalizedObservedLines,
): NormalizedObservedLines {
	return {
		explicit: mergeExplicitLines(current.explicit, incoming.explicit),
		synthetic: new Set([...current.synthetic, ...incoming.synthetic]),
	};
}

function describeLineList(lines: readonly number[]): string {
	if (lines.length <= 6) return lines.join(", ");
	return `${lines.slice(0, 6).join(", ")}, …`;
}

/** One full-file version observed at a point in time. */
export class Snapshot {
	readonly fullText: string;
	readonly recordedAt: number;
	#observedLines: NormalizedObservedLines;

	constructor(
		readonly path: string,
		text: string,
		readonly hash: string,
		observedLines: ObservedLines = "all",
		recordedAt: number = Date.now(),
	) {
		this.fullText = text;
		this.recordedAt = recordedAt;
		this.#observedLines = normalizeObservedLines(observedLines);
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

	mergeObservedLines(observedLines: ObservedLines): void {
		this.#observedLines = mergeObservedLines(this.#observedLines, normalizeObservedLines(observedLines));
	}

	unobservedAnchorWarning(
		anchorLines: readonly number[],
		options: { allowSynthetic?: boolean } = {},
	): string | undefined {
		const { explicit, synthetic } = this.#observedLines;
		if (explicit === null) return undefined;
		const missingExplicit = [...new Set(anchorLines)].filter((line) => !explicit.has(line)).sort((a, b) => a - b);
		const unauthorized = options.allowSynthetic
			? missingExplicit.filter((line) => !synthetic.has(line))
			: missingExplicit;
		if (unauthorized.length === 0) return undefined;
		const syntheticOnly = unauthorized.filter((line) => synthetic.has(line));
		const neverDisplayed = unauthorized.filter((line) => !synthetic.has(line));
		if (syntheticOnly.length > 0 && neverDisplayed.length === 0) {
			return (
				`This edit anchors to line(s) ${describeLineList(syntheticOnly)} of ${this.path} that [${this.path}#${this.hash}] displayed only as synthetic context. ` +
				`Re-read the exact target range before editing those lines.`
			);
		}
		return (
			`This edit anchors to line(s) ${describeLineList(unauthorized)} of ${this.path} that [${this.path}#${this.hash}] did not display as explicitly requested or matched lines. ` +
			`Re-read the exact target range before making further line-numbered edits across unseen gaps.`
		);
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

	/** Record full normalized text and the observed line numbers for `path`; returns its tag. */
	abstract record(path: string, fullText: string, observedLines?: ObservedLines): string;

	/** Drop snapshots belonging to a single path. */
	abstract invalidate(path: string): void;

	/** Drop every snapshot. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;

interface InMemorySnapshotStoreOptions {
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

	record(path: string, fullText: string, observedLines: ObservedLines = "all"): string {
		const hash = computeFileHash(fullText);
		const history = this.#versions.get(path) ?? [];
		const existing = history.find((snapshot) => snapshot.hash === hash);
		if (existing) {
			existing.mergeObservedLines(observedLines);
			this.#versions.set(path, [existing, ...history.filter((snapshot) => snapshot !== existing)]);
			for (const evicted of touchPathOrder(this.#pathOrder, path, this.#maxPaths)) this.#versions.delete(evicted);
			return hash;
		}

		const snapshot = new Snapshot(path, fullText, hash, observedLines);
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
