/** A session entry reduced to the fields that place it in display history. */
export interface HistoryEntry {
	readonly id: string;
	readonly type: string;
}

/** Saved entries between two compactions that are no longer part of the model context. */
export interface TranscriptEpoch<Entry extends HistoryEntry> {
	/** Changes when the epoch's first or last entry changes, so a grown epoch is rebuilt. */
	readonly key: string;
	readonly entries: readonly Entry[];
}

/**
 * Split the active branch into display-only epochs. Entries that Pi still renders as model context
 * are excluded, so a history page never duplicates the live transcript. Each compaction starts an epoch.
 */
export function historyEpochs<Entry extends HistoryEntry>(
	branch: readonly Entry[],
	context: ReadonlySet<string>,
): TranscriptEpoch<Entry>[] {
	const groups: Entry[][] = [];
	let current: Entry[] = [];
	for (const entry of branch) {
		if (context.has(entry.id)) continue;
		if (entry.type === "compaction" && current.length) {
			groups.push(current);
			current = [];
		}
		current.push(entry);
	}
	if (current.length) groups.push(current);
	return groups.map((entries) => ({ key: `${entries[0]!.id}:${entries.at(-1)!.id}`, entries }));
}

/** Inclusive range of loaded epochs; `hi < lo` means nothing is loaded. */
export interface EpochWindow {
	readonly lo: number;
	readonly hi: number;
}

/** The newest `size` epochs, adjacent to the live transcript. */
export function defaultWindow(count: number, size: number): EpochWindow {
	return { lo: Math.max(0, count - Math.max(0, size)), hi: count - 1 };
}

/**
 * Keep a window valid after the epoch count changes. A window that touched the live transcript
 * keeps touching it, so the entries the reader was looking at stay loaded when they become history.
 */
export function rebaseWindow(window: EpochWindow, previousCount: number, count: number, size: number): EpochWindow {
	if (count <= 0) return { lo: 0, hi: -1 };
	if (window.hi < window.lo || previousCount <= 0) return defaultWindow(count, size);
	const hi = window.hi >= previousCount - 1 ? count - 1 : Math.min(window.hi, count - 1);
	return { lo: Math.min(Math.max(0, window.lo), hi), hi };
}
