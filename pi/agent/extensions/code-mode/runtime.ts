/**
 * Cells, the kernels they run in, and the yield window between them. The window bounds the model's turn and not the
 * cell's life, so a cell can spawn agents or run a long build without blocking the turn.
 */

import { approxTokenCount } from "../shared/output-budget.ts";
import { type NestedRawResult, NestedToolError, normalizeToolArgs, type ToolCatalogEntry } from "./nested-dispatch.ts";
import type { CellOutcome, HostBridge } from "./rust-kernel.ts";
import { RustCellKernel } from "./rust-kernel.ts";

export type CellLanguage = "js" | "ts";

/** Expiry kills the kernel and its state, so this is generous. Time inside a host call is frozen. */
export const CELL_HARD_TIMEOUT_MS = 10 * 60_000;

/**
 * The only bound that never pauses, so it is the one that catches a cell stuck inside host calls.
 *
 * Derived, not chosen: one nested wait maxes at 120_000 (`write_stdin`'s documented ceiling) and
 * `CELL_HARD_TIMEOUT_MS` already allows 600_000 of cell time, so 900_000 admits ~7 consecutive maximal waits
 * alongside a full cell-time budget. A cell past that is stuck, not working. The ordering the three must keep is
 * `yield window <= write_stdin ceiling < hard timeout < wall ceiling`, asserted in yield-window.test.ts.
 */
export const CELL_WALL_TIMEOUT_MS = 15 * 60_000;

/** The host observer yields first, leaving the outer tool window time to receive and render that response. */
export const CELL_YIELD_GRACE_MS = 1_000;

/** A finished call rides in the result's `details`, which is written to the session file. */
const MAX_ARGUMENT_CHARS = 400;
export const MAX_PREVIEW_CHARS = 200;
/** `read` ships its syntax-highlighted rows in `details`. Entries are kept or dropped whole to stay valid JSON. */
const MAX_DETAIL_VALUE_CHARS = 200;
const MAX_DETAILS_CHARS = 600;

export interface NestedCallRecord {
	name: string;
	toolCallId: string;
	argsClipped?: boolean;
	args: unknown;
	status: "running" | "completed" | "error";
	startedAt: number;
	durationMs?: number;
	preview?: string;
	resultTokens?: number;
	details?: Record<string, unknown>;
	/** Set when `clipDetails` dropped a field, so a replayed row never rebuilds a result from a partial record. */
	detailsClipped?: boolean;
}

/**
 * A side table and not a field, because the record reaches the session file and a full result per call is what
 * `clipDetails` exists to keep out. A replayed row finds nothing here and degrades to its call renderer.
 */
const liveResults = new WeakMap<NestedCallRecord, NestedRawResult>();
const liveFailures = new WeakMap<NestedCallRecord, string>();

export function nestedCallResult(call: NestedCallRecord): NestedRawResult | undefined {
	return liveResults.get(call);
}
export function nestedCallFailureText(call: NestedCallRecord): string | undefined {
	return liveFailures.get(call);
}

// Two consumers, one index: the TUI's residue rule at render.ts:493 hides the copies, `echoNotice` tells the model it printed them.
// Index every line: a 32,768-byte cap keyed a truncated prefix, so a single-line JSON result never matched what the cell printed.
export function echoedLines(calls: ReadonlyArray<NestedCallRecord> | undefined): ReadonlySet<string> {
	const echoed = new Set<string>();
	for (const call of calls ?? []) {
		if (call.preview) echoed.add(call.preview.trim());
		for (const part of nestedCallResult(call)?.content ?? []) {
			if (part.type !== "text" || typeof part.text !== "string") continue;
			let at = 0;
			while (at <= part.text.length) {
				const next = part.text.indexOf("\n", at);
				const end = next === -1 ? part.text.length : next;
				const trimmed = part.text.slice(at, end).trim();
				if (trimmed.length > 0) echoed.add(trimmed);
				if (next === -1) break;
				at = next + 1;
			}
		}
	}
	return echoed;
}

export function settledCallCount(calls: ReadonlyArray<NestedCallRecord> | undefined): number {
	return (calls ?? []).reduce((count, call) => (call.status === "running" ? count : count + 1), 0);
}

export function countEchoed(text: string, echoed: ReadonlySet<string>): { printed: number; copied: number } {
	let printed = 0;
	let copied = 0;
	for (const line of text ? text.split(/\r?\n/) : []) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		printed += 1;
		if (echoed.has(trimmed)) copied += 1;
	}
	return { printed, copied };
}

/** A ten-read cell printed 691 lines and copied 676, 97.8%; a five-read cell was near 100%. 10 lines and 80% clear both and spare an answer that quotes a line or two. */
const NOTICE_MIN_PRINTED_LINES = 10;
const NOTICE_MIN_COPIED_SHARE = 0.8;

export function echoNotice(text: string, calls: ReadonlyArray<NestedCallRecord> | undefined): string | undefined {
	if (!text || (calls?.length ?? 0) === 0) return undefined;
	const { printed, copied } = countEchoed(text, echoedLines(calls));
	if (printed < NOTICE_MIN_PRINTED_LINES || copied < printed * NOTICE_MIN_COPIED_SHARE) return undefined;
	return `Context notice: ${copied} of ${printed} printed lines were verbatim tool output. A derived answer belongs here, not the copy.`;
}

export interface CellRecord {
	id: number;
	language: CellLanguage;
	code: string;
	startedAt: number;
	calls: NestedCallRecord[];
	onActivity?: () => void;
	onYield?: () => void;
	onWait?: (yieldMs: number) => void;
	yielded?: boolean;
	// Record completion so a later wait answers without racing.
	settled?: { outcome?: CellOutcome; error?: Error };
	promise: Promise<CellOutcome>;
}

function clipArguments(args: unknown): { value: unknown; clipped: boolean } {
	if (!args || typeof args !== "object" || Array.isArray(args)) return { value: args, clipped: false };
	const clipped: Record<string, unknown> = {};
	let changed = false;
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		const next =
			typeof value === "string" && value.length > MAX_ARGUMENT_CHARS
				? `${value.slice(0, MAX_ARGUMENT_CHARS)}\u2026`
				: value;
		changed ||= next !== value;
		clipped[key] = next;
	}
	return { value: clipped, clipped: changed };
}

function previewOf(text: string): string | undefined {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const first = lines[0]?.trim();
	if (!first) return undefined;
	const head = first.length > MAX_PREVIEW_CHARS ? `${first.slice(0, MAX_PREVIEW_CHARS)}…` : first;
	return lines.length > 1 ? `${head} · ${lines.length} lines` : head;
}

// Artifact summaries contain the complete small card; preserve them instead of rejecting replay because raw resource fields were clipped.
function artifactReplayDetails(details: unknown): Record<string, unknown> | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const summary = (details as Record<string, unknown>).resourceSummary;
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
	if ((summary as Record<string, unknown>).scheme !== "artifact") return undefined;
	try {
		if (JSON.stringify(summary).length > MAX_DETAILS_CHARS) return undefined;
	} catch {
		return undefined;
	}
	return { resourceSummary: summary };
}
function clipDetails(details: unknown): { kept?: Record<string, unknown>; dropped: boolean } {
	const artifact = artifactReplayDetails(details);
	if (artifact) return { kept: artifact, dropped: false };
	if (!details || typeof details !== "object" || Array.isArray(details)) return { dropped: false };
	const kept: Record<string, unknown> = {};
	let dropped = false;
	let budget = MAX_DETAILS_CHARS;
	for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
		let serialised: string | undefined;
		try {
			serialised = JSON.stringify(value);
		} catch {
			dropped = true;
			continue;
		}
		if (serialised === undefined || serialised.length > MAX_DETAIL_VALUE_CHARS || serialised.length > budget) {
			dropped = true;
			continue;
		}
		budget -= serialised.length;
		kept[key] = value;
	}
	return { kept: Object.keys(kept).length > 0 ? kept : undefined, dropped };
}

function startCall(record: CellRecord, name: string, args: unknown): NestedCallRecord {
	const clipped = clipArguments(normalizeToolArgs(name, args));
	const call: NestedCallRecord = {
		name,
		// Random and not positional: two concurrent cells calling the same tool collide in a tracker keyed on this.
		toolCallId: `cell-${name}-${Math.random().toString(36).slice(2, 10)}`,
		// `tools.read("justfile")` reaches `execute` as `{path}` (nested-dispatch.ts:129) but reached the row as a bare
		// string, and `readDisplay` (fileops/index.ts:2470) printed `[invalid]` for 159 of 1,056 recorded reads.
		args: clipped.value,
		argsClipped: clipped.clipped || undefined,
		status: "running",
		startedAt: Date.now(),
	};
	record.calls.push(call);
	record.onActivity?.();
	return call;
}

function finishCall(
	record: CellRecord,
	call: NestedCallRecord,
	status: "completed" | "error",
	text: string,
	raw?: NestedRawResult,
): void {
	if (call.status !== "running") return;
	call.status = status;
	call.durationMs = Date.now() - call.startedAt;
	call.preview = previewOf(text);
	if (status === "error") liveFailures.set(call, text);
	// From the bounded text the cell received; a row that has lost its card has nothing else to price itself with.
	call.resultTokens = text ? approxTokenCount(text) : 0;
	const clipped = clipDetails(raw?.details);
	call.details = clipped.kept;
	// `output` is 200-char-capped away for any real command, and exec_command's card reads it unguarded
	// (exec-cell-rendering-internal.ts:266). A row whose details lost a field is not a result any renderer can be handed.
	call.detailsClipped = clipped.dropped || undefined;
	if (raw) liveResults.set(call, raw);
	record.onActivity?.();
}
function failPendingCalls(record: CellRecord, reason: string | undefined): void {
	if (!reason) return;
	let changed = false;
	for (const call of record.calls) {
		if (call.status !== "running") continue;
		call.status = "error";
		call.durationMs = Date.now() - call.startedAt;
		call.preview = `cell ended before ${call.name} returned: ${previewOf(reason) ?? "cell failed"}`;
		changed = true;
	}
	if (changed) record.onActivity?.();
}

export interface CollectResult {
	record: CellRecord;
	outcome?: CellOutcome;
	error?: Error;
	done: boolean;
	durationMs: number;
}

export class CellSession {
	private kernel: RustCellKernel | undefined;
	private readonly cells = new Map<number, CellRecord>();
	private nextCellId = 1;
	private readonly kernelBridge: HostBridge = {
		callTool: async (hostCall) => {
			const record = hostCall.cellId === undefined ? undefined : this.cells.get(hostCall.cellId);
			const call = record ? startCall(record, hostCall.name, hostCall.args) : undefined;
			try {
				// `raw` is the row's copy and stays host-side; the rest goes back down the pipe.
				const { raw, ...forCell } = await this.host.callTool({ ...hostCall, toolCallId: call?.toolCallId });
				if (record && call) finishCall(record, call, "completed", forCell.text, raw);
				return forCell;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (record && call)
					finishCall(record, call, "error", message, error instanceof NestedToolError ? error.raw : undefined);
				throw error;
			}
		},
		notify: (text, cellId) => this.host.notify(text, cellId),
	};

	constructor(private readonly host: HostBridge) {}

	reset(): void {
		this.kernel?.reset();
		this.kernel = undefined;
	}

	dispose(): void {
		this.kernel?.reset();
		this.kernel = undefined;
	}

	cell(id: number): CellRecord | undefined {
		return this.cells.get(id);
	}

	start(options: {
		code: string;
		language?: CellLanguage;
		yieldTimeMs?: number;
		catalog: ToolCatalogEntry[];
		signal?: AbortSignal;
	}): CellRecord {
		const id = this.nextCellId++;
		const language = options.language ?? "ts";
		const kernel = this.ensureKernel();
		const started = kernel.run(id, options.code, options.catalog, options.signal, options.yieldTimeMs);
		const record: CellRecord = {
			id,
			language,
			code: options.code,
			startedAt: Date.now(),
			calls: [],
			onYield: () => {
				record.yielded = true;
			},
			onWait: (yieldMs) => {
				record.yielded = false;
				kernel.wait(id, Math.max(0, yieldMs - CELL_YIELD_GRACE_MS));
			},
			promise: started.then(
				(outcome) => {
					record.settled = { outcome };
					failPendingCalls(record, outcome.error);
					return outcome;
				},
				(error: Error) => {
					record.settled = { error };
					failPendingCalls(record, error.message);
					throw error;
				},
			),
		};
		record.promise.catch(() => {});
		this.cells.set(id, record);
		return record;
	}

	private ensureKernel(): RustCellKernel {
		if (!this.kernel) this.kernel = new RustCellKernel(undefined, this.kernelBridge);
		return this.kernel;
	}
}

/** `collect`'s yield timer below pauses while this is true; the Rust host freezes CELL_HARD_TIMEOUT_MS the same way. */
export function hostCallOutstanding(record: CellRecord): boolean {
	return record.calls.some((call) => call.status === "running");
}

// The window measures the cell's own work, so it stops while the cell is blocked in a tool: a nested `write_stdin`
// waiting its documented 120_000 used to hand the turn back at 30_000 and cost a `wait` turn to collect. 100ms of
// granularity against a 30_000 default is 0.3%, and `CELL_WALL_TIMEOUT_MS` is what now bounds a stuck cell.
const YIELD_TICK_MS = 100;

export async function collect(record: CellRecord, yieldMs: number): Promise<CollectResult> {
	if (record.yielded && !record.settled) record.onWait?.(yieldMs);
	const pending = Symbol("pending");
	let timer: NodeJS.Timeout | undefined;
	const yielded = new Promise<typeof pending>((resolve) => {
		let remainingMs = yieldMs;
		let last = Date.now();
		timer = setInterval(() => {
			const now = Date.now();
			const elapsed = now - last;
			last = now;
			if (hostCallOutstanding(record)) return;
			remainingMs -= elapsed;
			if (remainingMs <= 0) resolve(pending);
		}, YIELD_TICK_MS);
		timer.unref?.();
	});
	try {
		const outcome = await Promise.race([record.promise, yielded]);
		if (outcome === pending) {
			record.onYield?.();
			return { record, done: false, durationMs: Date.now() - record.startedAt };
		}
		return { record, outcome: outcome as CellOutcome, done: true, durationMs: Date.now() - record.startedAt };
	} catch (error) {
		return {
			record,
			error: error instanceof Error ? error : new Error(String(error)),
			done: true,
			durationMs: Date.now() - record.startedAt,
		};
	} finally {
		if (timer) clearInterval(timer);
	}
}

export class CellSessionRegistry {
	private readonly sessions = new Map<string, CellSession>();

	session(sessionId: string, createBridge: () => HostBridge): CellSession {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = new CellSession(createBridge());
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	reset(sessionId?: string): void {
		if (sessionId) {
			const session = this.sessions.get(sessionId);
			if (!session) return;
			session.dispose();
			this.sessions.delete(sessionId);
			return;
		}
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
	}
}
