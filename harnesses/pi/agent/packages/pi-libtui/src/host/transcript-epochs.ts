/** A session entry reduced to the fields that place it in display history. */
export interface HistoryEntry {
	readonly id: string;
	readonly type: string;
	readonly message?: { readonly role?: string };
}

/**
 * Index-aligned answer to "may a page start before this entry?" for one compaction epoch. A page start
 * ends the projection's visual groups, so the projection chooses positions where its groups already end.
 */
export type HistoryBreaks<Entry extends HistoryEntry> = (entries: readonly Entry[]) => readonly boolean[];

/** A contiguous slice of saved history that loads and unloads as one page. */
export interface TranscriptChunk<Entry extends HistoryEntry> {
	/** Changes when the chunk's first or last entry changes, so a regrouped chunk is rebuilt. */
	readonly key: string;
	readonly entries: readonly Entry[];
	/** Compaction epoch, counting from the oldest saved history. */
	readonly epoch: number;
	/** Whether the chunk starts its epoch. */
	readonly first: boolean;
	/** Entries that produce transcript rows. */
	readonly size: number;
}

/** Chunk sizing, in entries that produce transcript rows. */
export interface ChunkLimits {
	/** A chunk ends at the first allowed break after it reaches this size. */
	readonly min: number;
	/** A chunk ends at the next step boundary after this size, even inside a visual group. */
	readonly max: number;
}

function displayed(entry: HistoryEntry): boolean {
	if (entry.type === "message") return entry.message?.role !== "toolResult" && entry.message?.role !== "system";
	return entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction";
}

/**
 * Split the active branch into display-only history chunks. Entries that Pi still renders as model context
 * are excluded, so a page never duplicates the live transcript. Each compaction starts a chunk, and a chunk
 * never starts at a tool result, because Pi pairs tool calls with results only within one rendered batch.
 */
export function historyChunks<Entry extends HistoryEntry>(
	branch: readonly Entry[],
	context: ReadonlySet<string>,
	limits: ChunkLimits,
	breaks?: HistoryBreaks<Entry>,
): TranscriptChunk<Entry>[] {
	const epochs: Entry[][] = [];
	let current: Entry[] = [];
	for (const entry of branch) {
		if (context.has(entry.id)) continue;
		if (entry.type === "compaction" && current.length) {
			epochs.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length) epochs.push(current);
	const chunks: TranscriptChunk<Entry>[] = [];
	for (const [epoch, entries] of epochs.entries()) {
		const allowed = breaks?.(entries);
		let start = 0;
		let size = 0;
		const close = (end: number) => {
			const slice = entries.slice(start, end);
			chunks.push({
				key: `${slice[0]!.id}:${slice.at(-1)!.id}`,
				entries: slice,
				epoch,
				first: start === 0,
				size,
			});
			start = end;
			size = 0;
		};
		for (const [index, entry] of entries.entries()) {
			if (index > start && entry.message?.role !== "toolResult") {
				const clean = allowed ? allowed[index] === true : true;
				if ((clean && size >= limits.min) || size >= limits.max) close(index);
			}
			if (displayed(entry)) size++;
		}
		close(entries.length);
	}
	return chunks;
}

/** Inclusive range of loaded chunks; `hi < lo` means nothing is loaded. */
export interface ChunkWindow {
	readonly lo: number;
	readonly hi: number;
}

/** The newest chunks, adjacent to the live transcript, holding at least `entries` displayed entries. */
export function defaultWindow(chunks: readonly TranscriptChunk<HistoryEntry>[], entries: number): ChunkWindow {
	const hi = chunks.length - 1;
	let lo = hi;
	let size = chunks[hi]?.size ?? 0;
	while (lo > 0 && size < entries) size += chunks[--lo]!.size;
	return { lo: Math.max(0, lo), hi };
}

/**
 * Keep a window on the same entries after history is regrouped or grows. A window that touched the live
 * transcript keeps touching it, so the entries the reader was looking at stay loaded when they become history.
 */
export function rebaseWindow(
	window: ChunkWindow,
	previous: readonly TranscriptChunk<HistoryEntry>[],
	chunks: readonly TranscriptChunk<HistoryEntry>[],
	entries: number,
): ChunkWindow {
	if (!chunks.length) return { lo: 0, hi: -1 };
	const first = previous[window.lo]?.entries[0]?.id;
	const last = previous[window.hi]?.entries.at(-1)?.id;
	if (window.hi < window.lo || first === undefined || last === undefined) return defaultWindow(chunks, entries);
	const owner = new Map<string, number>();
	for (const [index, chunk] of chunks.entries()) for (const entry of chunk.entries) owner.set(entry.id, index);
	const lo = owner.get(first);
	const hi = window.hi === previous.length - 1 ? chunks.length - 1 : owner.get(last);
	if (lo === undefined || hi === undefined || hi < lo) return defaultWindow(chunks, entries);
	return { lo, hi };
}
