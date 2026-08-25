import { getTuiRenderEpoch } from "./render-epoch.ts";

/** Options for a bounded exact-key cache. */
interface ExactRenderCacheOptions {
	/** Maximum retained entries. The least recently used entry is evicted first. */
	maxEntries?: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** A small exact-key LRU cache for rendered values. */
class ExactRenderCache<Key, Value> {
	private readonly entries = new Map<Key, Value>();
	private readonly maxEntries: number;

	constructor(options: ExactRenderCacheOptions = {}) {
		this.maxEntries = positiveInteger(options.maxEntries, 8);
	}

	/** Return an exact cached value, producing it once on a miss. */
	get(key: Key, produce: () => Value): Value {
		const cached = this.entries.get(key);
		if (cached !== undefined || this.entries.has(key)) {
			this.entries.delete(key);
			this.entries.set(key, cached as Value);
			return cached as Value;
		}
		const value = produce();
		if (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) this.entries.delete(oldest.value);
		}
		this.entries.set(key, value);
		return value;
	}

	/** Remove all retained values. */
	clear(): void {
		this.entries.clear();
	}

	/** Current retained entry count. */
	get size(): number {
		return this.entries.size;
	}
}
/** Bounded cache keyed exactly by terminal width and a caller-owned content key. */
export class RenderedLinesCache {
	private readonly widths: ExactRenderCache<number, ExactRenderCache<string, string[]>>;
	private readonly maxContentKeys: number;
	private epoch = getTuiRenderEpoch();

	constructor(options: { maxWidths?: number; maxContentKeysPerWidth?: number } = {}) {
		this.widths = new ExactRenderCache({ maxEntries: positiveInteger(options.maxWidths, 4) });
		this.maxContentKeys = positiveInteger(options.maxContentKeysPerWidth, 2);
	}

	/** Return the original rendered line array for an exact width and content key. */
	get(width: number, contentKey: string, produce: () => string[]): string[] {
		const epoch = getTuiRenderEpoch();
		if (epoch !== this.epoch) {
			this.epoch = epoch;
			this.clear();
		}
		const byContent = this.widths.get(width, () => new ExactRenderCache({ maxEntries: this.maxContentKeys }));
		return byContent.get(contentKey, produce);
	}

	/** Drop every cached width and content key. */
	clear(): void {
		this.widths.clear();
	}

	/** Number of retained terminal widths. */
	get widthCount(): number {
		return this.widths.size;
	}
}
