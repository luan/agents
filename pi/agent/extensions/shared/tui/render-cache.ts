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
export class RenderedLineCache {
	private width: number | undefined;
	private key: string | undefined;
	private lines: string[] | undefined;

	get(width: number, key: string, produce: () => string[]): string[] {
		if (this.lines && this.width === width && this.key === key) return this.lines;
		const lines = produce();
		this.width = width;
		this.key = key;
		this.lines = lines;
		return lines;
	}

	clear(): void {
		this.lines = undefined;
		this.width = undefined;
		this.key = undefined;
	}
}
