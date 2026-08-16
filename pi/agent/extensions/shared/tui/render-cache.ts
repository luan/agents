/**
 * Caches the lines a component last produced, keyed on render width plus a content key.
 *
 * Tool renderers are re-invoked whenever args, results, expansion, or the theme change,
 * so a component instance only ever needs to lay out its lines once per width. The
 * working animation, however, calls `render()` on the whole tree ~31x/second, and every
 * uncached call re-wraps and re-measures each line through `Intl.Segmenter`. pi-tui's own
 * `Text`, `Box`, and `Markdown` cache for the same reason; views that build a fresh `Text`
 * per render need this to get the same benefit.
 */
const MAX_CACHED_RENDERS = 8;

export class RenderedLineCache {
	private readonly entries = new Map<string, string[]>();

	get(width: number, key: string, produce: () => string[]): string[] {
		const entryKey = `${width}\0${key}`;
		const cached = this.entries.get(entryKey);
		if (cached) return cached;
		const lines = produce();
		if (this.entries.size >= MAX_CACHED_RENDERS) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}
		this.entries.set(entryKey, lines);
		return lines;
	}

	clear(): void {
		this.entries.clear();
	}
}
