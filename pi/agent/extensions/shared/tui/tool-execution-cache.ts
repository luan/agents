import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

const COMPLETED_TOOL_RENDER_CACHE = Symbol.for("pi.completedToolRenderCache.installed");
const MAX_CACHED_WIDTHS = 8;

interface ToolExecutionPrototype {
	[COMPLETED_TOOL_RENDER_CACHE]?: true;
	isPartial: boolean;
	render(width: number): string[];
	updateDisplay(): void;
	invalidate(): void;
}

interface ToolRenderCache {
	linesByWidth: Map<number, string[]>;
}

const caches = new WeakMap<object, ToolRenderCache>();

function cacheFor(owner: object): ToolRenderCache {
	let cache = caches.get(owner);
	if (!cache) {
		cache = { linesByWidth: new Map() };
		caches.set(owner, cache);
	}
	return cache;
}

function clearCache(owner: object): void {
	caches.delete(owner);
}

/**
 * Keep completed transcript tools at O(1) layout cost for each recent width.
 *
 * Pi keeps one ToolExecutionComponent for each transcript tool call. Its normal
 * render path still traverses every renderer on every unrelated TUI frame. The
 * private partial flag is the stable ownership boundary: content, expansion,
 * theme, and result changes all pass through updateDisplay before a completed
 * component can render again.
 */
export function installCompletedToolRenderCache(): void {
	const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype;
	if (proto[COMPLETED_TOOL_RENDER_CACHE]) return;

	const originalRender = proto.render;
	const originalUpdateDisplay = proto.updateDisplay;
	const originalInvalidate = proto.invalidate;

	proto.render = function renderCachedCompletedTool(this: ToolExecutionPrototype, width: number): string[] {
		if (this.isPartial) return originalRender.call(this, width);

		const cache = cacheFor(this);
		const cached = cache.linesByWidth.get(width);
		if (cached) return cached;

		const lines = originalRender.call(this, width);
		if (cache.linesByWidth.size >= MAX_CACHED_WIDTHS) {
			const oldestWidth = cache.linesByWidth.keys().next().value;
			if (oldestWidth !== undefined) cache.linesByWidth.delete(oldestWidth);
		}
		cache.linesByWidth.set(width, lines);
		return lines;
	};

	proto.updateDisplay = function updateDisplayWithRenderInvalidation(this: ToolExecutionPrototype): void {
		clearCache(this);
		originalUpdateDisplay.call(this);
	};

	proto.invalidate = function invalidateCompletedToolRender(this: ToolExecutionPrototype): void {
		clearCache(this);
		originalInvalidate.call(this);
	};

	proto[COMPLETED_TOOL_RENDER_CACHE] = true;
}
