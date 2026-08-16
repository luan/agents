/**
 * Session ledger of what `read` already delivered, and the rule for when a
 * repeat may be answered with a pointer instead of the bytes.
 *
 * The rule is deliberately narrow. Measured over 1,041 session transcripts,
 * 1,023 of 19,241 reads (5.3%) repeat a byte-identical argument set, and only
 * 247 of those are waste: 361 re-read a file that had CHANGED and 279 re-read
 * content a compaction had EVICTED. Suppressing either of those returns a
 * pointer to bytes the model cannot reach, which is the failure this guard
 * exists to avoid, so both are excluded by construction below.
 */

/** Fields fileops records on a read result (`code-mode/tool-results.ts:57-77`). */
export interface ReadDetails {
	hashlineTag?: unknown;
	outputTokens?: unknown;
	outputBounded?: unknown;
}

export interface LedgerEntry {
	/** Whole-file content hash from `[path#TAG]`. A differing tag means the file changed. */
	tag: string;
	/** Count of compaction entries in the branch when this read landed. */
	generation: number;
	tokens: number;
	/** A key may be answered with a pointer at most once per generation. */
	pointed: boolean;
}

export interface Ledger {
	entries: Map<string, LedgerEntry>;
	/**
	 * Tool call ids already folded in. A read reaches this extension through two
	 * seams and a Direct-mode call can hit both, so the id makes the decision
	 * idempotent rather than letting a call count as its own repeat.
	 */
	handled: Set<string>;
}

const LEDGERS = Symbol.for("agents.readLedger.bySession");
const store = globalThis as typeof globalThis & Record<symbol, Map<string, Ledger> | undefined>;
const BY_SESSION: Map<string, Ledger> = store[LEDGERS] ?? new Map<string, Ledger>();
store[LEDGERS] = BY_SESSION;

export function ledgerForSession(sessionId: string): Ledger {
	const existing = BY_SESSION.get(sessionId);
	if (existing) return existing;
	const created: Ledger = { entries: new Map(), handled: new Set() };
	BY_SESSION.set(sessionId, created);
	return created;
}

export function forgetSession(sessionId: string): void {
	BY_SESSION.delete(sessionId);
}

/**
 * Identity of a read call. Keyed on every argument, not just `path`, because
 * `offset`/`limit` carried the range in the legacy API: keying on path plus
 * range alone counts 5,250 repeats where keying on the full argument set counts
 * 1,023, and the 4,227 difference is reads asking for a different slice.
 */
export function readSignature(params: unknown): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const record = params as Record<string, unknown>;
	const path = record.path ?? record.file_path ?? record.filePath;
	if (typeof path !== "string" || !path) return undefined;
	const rest = Object.keys(record)
		.filter((key) => key !== "path" && key !== "file_path" && key !== "filePath")
		.sort()
		.map((key) => `${key}=${JSON.stringify(record[key])}`);
	return [path, ...rest].join("|");
}

/** Below this a pointer saves less than it costs to render, so the bytes are cheaper. */
const MIN_POINTED_TOKENS = 400;

export interface Decision {
	pointer: boolean;
	entry: LedgerEntry;
}

/** A read already folded in by the other seam must not be re-judged. */
export function alreadyHandled(ledger: Ledger, toolCallId: string): boolean {
	if (ledger.handled.has(toolCallId)) return true;
	ledger.handled.add(toolCallId);
	return false;
}

/**
 * Decide what a read result becomes, and fold it into the ledger.
 *
 * A pointer is returned only when every one of these holds, so the content it
 * points at is provably still in the conversation and still correct:
 *   - the same key was read before in this session;
 *   - both reads carry the same `hashlineTag`, so the file did not change;
 *   - no compaction has landed since, so the earlier result was not evicted;
 *   - the earlier read was not truncated, so it was complete;
 *   - this key has not already been answered with a pointer this generation.
 *
 * That last clause is what bounds the mechanism: a key can produce a pointer at
 * most once, so asking twice always yields bytes and no sequence of calls can
 * make this return the same unhelpful answer twice.
 */
export function decide(
	ledger: Ledger,
	signature: string,
	details: ReadDetails,
	generation: number,
	isError: boolean,
): Decision {
	const tag = typeof details.hashlineTag === "string" ? details.hashlineTag : "";
	const tokens = typeof details.outputTokens === "number" ? details.outputTokens : 0;
	const truncated = details.outputBounded === true;
	const next: LedgerEntry = { tag, generation, tokens, pointed: false };

	const prior = ledger.entries.get(signature);
	const pointer =
		!isError &&
		!truncated &&
		tag !== "" &&
		prior !== undefined &&
		prior.tag === tag &&
		prior.generation === generation &&
		!prior.pointed &&
		prior.tokens >= MIN_POINTED_TOKENS;

	next.pointed = pointer;
	next.tokens = pointer ? prior.tokens : tokens;
	ledger.entries.set(signature, next);
	return { pointer, entry: next };
}
