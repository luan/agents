import { InteractiveMode, type SessionEntry, type SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import {
	defaultWindow,
	type EpochWindow,
	historyEpochs,
	rebaseWindow,
	type TranscriptEpoch,
} from "./transcript-epochs.ts";

const PROTOCOL = "pi-libtui/transcript-history/v2" as const;
const KEY = Symbol.for(PROTOCOL);
const OWNER = Symbol.for(`${PROTOCOL}/owner`);
// An installed copy that still renders the full branch owns these methods; never stack on top of it.
const LEGACY = Symbol.for("pi-libtui/transcript-history/v1");
const PROJECTION = Symbol.for("pi-libtui/transcript-projection/v1");
/** Older epochs loaded next to the live transcript while the reader follows new output. */
const DEFAULT_PAGES = 1;
/** Loaded epochs before off-screen pages are released while the reader scrolls. */
const MAX_PAGES = 4;

/** Options for one TUI's display-history lease. */
export interface TranscriptHistoryOptions {
	/** Theme for the load markers; without it they render as plain text. */
	readonly theme?: Theme;
}
interface HistoryBridge {
	readonly protocol: typeof PROTOCOL;
	retain(): () => void;
	acquire(tui: TUI, options?: TranscriptHistoryOptions): () => void;
}
interface HistoryOwner {
	readonly protocol: typeof PROTOCOL;
	refresh(): void;
}
interface NativeMode {
	ui: TUI;
	sessionManager: Pick<SessionManager, "getBranch" | "buildContextEntries">;
	chatContainer: Container;
}
interface NativeScrollView {
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly isFollowingEnd: boolean;
	scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender?: () => void): void;
}
interface Projection {
	readonly renderedRows: number | undefined;
	rowOf(component: Component): number | undefined;
}
interface Geometry {
	readonly height: number;
	rowOf(component: Component): number | undefined;
}
type UpdateLayout = NativeScrollView["updateLayout"];
// type-boundary: Pi 1.0's private transcript methods and fields, and cross-copy leases; the guards below validate them before use.
type NativeValue = unknown;
function record(value: NativeValue): value is Record<PropertyKey, NativeValue> {
	return value !== null && typeof value === "object";
}
function nativeMode(value: NativeValue): value is NativeMode {
	return (
		record(value) &&
		record(value.ui) &&
		typeof value.ui.requestRender === "function" &&
		record(value.sessionManager) &&
		typeof value.sessionManager.getBranch === "function" &&
		typeof value.sessionManager.buildContextEntries === "function" &&
		record(value.chatContainer) &&
		Array.isArray(value.chatContainer.children) &&
		typeof value.chatContainer.addChild === "function" &&
		record(value.pendingTools) &&
		typeof value.pendingTools.clear === "function"
	);
}
function scrollView(value: NativeValue): value is NativeScrollView {
	return (
		record(value) &&
		typeof value.scrollTop === "number" &&
		typeof value.viewportHeight === "number" &&
		typeof value.isFollowingEnd === "boolean" &&
		typeof value.scrollTo === "function" &&
		typeof value.updateLayout === "function"
	);
}
function projection(value: NativeValue): value is Projection {
	return (
		record(value) &&
		typeof value.rowOf === "function" &&
		(value.renderedRows === undefined || typeof value.renderedRows === "number")
	);
}
function historyBridge(value: NativeValue): value is HistoryBridge {
	return (
		record(value) &&
		value.protocol === PROTOCOL &&
		typeof value.acquire === "function" &&
		typeof value.retain === "function"
	);
}
function historyOwner(value: NativeValue): value is HistoryOwner {
	return record(value) && value.protocol === PROTOCOL && typeof value.refresh === "function";
}

/**
 * Show saved history beyond the model context without loading all of it. Pi keeps rendering the
 * live context; older compaction epochs load above it as the fullscreen viewport approaches them
 * and unload when the reader returns to new output. Replace when Pi exposes a transcript-history API.
 */
export function installTranscriptHistory(tui: TUI, options?: TranscriptHistoryOptions): () => void {
	return ensureBridge()?.acquire(tui, options) ?? (() => {});
}

/** Prepare before Pi restores history on reload; session_start attaches the TUI afterwards. */
export function retainTranscriptHistory(): () => void {
	return ensureBridge()?.retain() ?? (() => {});
}

/** Marks where a loaded epoch starts; scroll anchoring measures it without rendering visible rows. */
class PageStart implements Component {
	constructor(private readonly rendered: (width: number) => void) {}
	render(width: number): string[] {
		this.rendered(width);
		return [];
	}
	invalidate(): void {}
}

/** A muted notice for epochs that exist but are not loaded. */
class HistoryMarker implements Component {
	text = "";
	constructor(
		private readonly rendered: (width: number) => void,
		private readonly theme: () => Theme | undefined,
	) {}
	render(width: number): string[] {
		this.rendered(width);
		if (width <= 0 || !this.text) return [];
		const line = truncateToWidth(this.text, width, "…");
		const theme = this.theme();
		return ["", theme ? tuiTheme(theme).fg("text.muted", line) : line];
	}
	invalidate(): void {}
}

interface Page {
	readonly start: PageStart;
	readonly components: readonly Component[];
}

function plural(count: number): string {
	return `${count} ${count === 1 ? "context window" : "context windows"}`;
}

/** The loaded slice of one interactive mode's saved history, kept in front of Pi's live chat. */
class HistoryWindow {
	theme: Theme | undefined;
	private epochs: TranscriptEpoch<SessionEntry>[] = [];
	private window: EpochWindow = { lo: 0, hi: -1 };
	private readonly pages = new Map<string, Page>();
	private owned = new Set<Component>();
	private readonly earlier: HistoryMarker;
	private readonly later: HistoryMarker;
	private pending: { anchor: Component; row: number } | undefined;
	private contentFrame = false;
	private width = 0;
	private fallback: Geometry | undefined;
	private scroll: { view: NativeScrollView; patched: UpdateLayout; own: UpdateLayout | undefined } | undefined;

	constructor(
		private readonly mode: NativeMode,
		private readonly renderEntries: (mode: NativeMode, entries: readonly SessionEntry[]) => void,
	) {
		const rendered = (width: number) => this.rendered(width);
		this.earlier = new HistoryMarker(rendered, () => this.theme);
		this.later = new HistoryMarker(rendered, () => this.theme);
	}

	/** Pi rebuilt its chat from the model context; recompute history and restore the loaded prefix. */
	sync(): void {
		this.attachScroll();
		const context = new Set(this.mode.sessionManager.buildContextEntries().map((entry) => entry.id));
		const epochs = historyEpochs(this.mode.sessionManager.getBranch(), context);
		const sameSession = epochs[0]?.entries[0]?.id === this.epochs[0]?.entries[0]?.id;
		const following = this.scroll?.view.isFollowingEnd ?? true;
		this.window =
			following || !sameSession
				? defaultWindow(epochs.length, DEFAULT_PAGES)
				: rebaseWindow(this.window, this.epochs.length, epochs.length, DEFAULT_PAGES);
		this.epochs = epochs;
		this.pending = undefined;
		this.apply();
	}

	dispose(): void {
		this.removePrefix();
		this.pages.clear();
		this.pending = undefined;
		if (this.scroll) {
			const { view, patched, own } = this.scroll;
			if (view.updateLayout === patched) {
				if (own) Reflect.set(view, "updateLayout", own);
				else Reflect.deleteProperty(view, "updateLayout");
			}
			this.scroll = undefined;
		}
		this.mode.ui.requestRender();
	}

	private rendered(width: number): void {
		this.contentFrame = true;
		this.width = width;
	}

	private attachScroll(): void {
		if (this.scroll) return;
		const view: NativeValue = Reflect.get(this.mode, "transcriptScrollView");
		if (!scrollView(view)) return;
		const original = view.updateLayout;
		const own = Object.hasOwn(view, "updateLayout") ? original : undefined;
		const window = this;
		const patched: UpdateLayout = function (this: NativeScrollView, contentHeight, viewportHeight, requestRender) {
			Reflect.apply(original, this, [contentHeight, viewportHeight, requestRender]);
			window.afterLayout(this, contentHeight);
		};
		Reflect.set(view, "updateLayout", patched);
		this.scroll = { view, patched, own };
	}

	/** Runs after every fullscreen layout, including scroll-only frames that reuse component output. */
	private afterLayout(view: NativeScrollView, contentHeight: number): void {
		const content = this.contentFrame;
		this.contentFrame = false;
		if (!this.epochs.length) return;
		const geometry = this.geometry(content);
		if (!geometry) return;
		if (this.pending) {
			// The prefix changed above the reader; wait for the frame that renders it, then hold the anchor still.
			if (!content) return;
			const row = geometry.rowOf(this.pending.anchor);
			const delta = row === undefined ? 0 : row - this.pending.row;
			this.pending = undefined;
			if (delta) view.scrollTo(view.scrollTop + delta, { disableFollow: true });
			return;
		}
		const offset = contentHeight - geometry.height;
		const top = view.scrollTop - offset;
		const height = Math.max(1, view.viewportHeight);
		const { lo, hi } = this.window;
		const count = this.epochs.length;
		if (view.isFollowingEnd) {
			if (hi < count - 1) {
				this.window = defaultWindow(count, DEFAULT_PAGES);
				this.apply();
				return;
			}
			// Short history cannot be scrolled; fill the screen so the earlier marker stays reachable.
			if (lo > 0 && top <= 0) {
				this.window = { lo: lo - 1, hi };
				this.apply();
				return;
			}
			// Release pages far above new output; the distance prevents reloading them immediately.
			let next = lo;
			while (hi - next + 1 > DEFAULT_PAGES) {
				const end = this.startRow(next + 1, geometry);
				if (end === undefined || end > top - 3 * height) break;
				next++;
			}
			if (next !== lo) {
				this.window = { lo: next, hi };
				this.apply();
			}
			return;
		}
		if (lo > 0 && top <= height) {
			this.move({ lo: lo - 1, hi }, top, height, geometry);
			return;
		}
		if (hi < count - 1) {
			const gap = geometry.rowOf(this.later);
			if (gap !== undefined && gap <= top + 2 * height) this.move({ lo, hi: hi + 1 }, top, height, geometry);
		}
	}

	private move(target: EpochWindow, top: number, height: number, geometry: Geometry): void {
		const previous = this.window;
		let { lo, hi } = target;
		while (hi - lo + 1 > MAX_PAGES) {
			if (lo < previous.lo) {
				// Loading earlier: release the newest page only once it is well below the viewport.
				const start = this.startRow(hi, geometry);
				if (start === undefined || start < top + 2 * height) break;
				hi--;
			} else {
				// Loading later: release the oldest page only once it ends well above the viewport.
				const end = lo + 1 <= previous.hi ? this.startRow(lo + 1, geometry) : geometry.rowOf(this.later);
				if (end === undefined || end > top - height) break;
				lo++;
			}
		}
		// Anchor the first page that stays loaded, so changes above it do not move what the reader sees.
		const anchorIndex = Math.max(lo, previous.lo);
		const anchor = anchorIndex <= previous.hi ? this.loadedPage(anchorIndex)?.start : undefined;
		const row = anchor ? geometry.rowOf(anchor) : undefined;
		this.window = { lo, hi };
		this.apply();
		if (anchor && row !== undefined) this.pending = { anchor, row };
	}

	private startRow(index: number, geometry: Geometry): number | undefined {
		const page = this.loadedPage(index);
		return page ? geometry.rowOf(page.start) : undefined;
	}

	private loadedPage(index: number): Page | undefined {
		const epoch = this.epochs[index];
		return epoch ? this.pages.get(epoch.key) : undefined;
	}

	private geometry(content: boolean): Geometry | undefined {
		const roots: NativeValue = Reflect.get(this.mode.ui, "children");
		const document: NativeValue = Array.isArray(roots) ? roots[0] : undefined;
		const installed: NativeValue = record(document) ? Reflect.get(document, PROJECTION) : undefined;
		if (projection(installed)) {
			const height = installed.renderedRows;
			return height === undefined ? undefined : { height, rowOf: (component) => installed.rowOf(component) };
		}
		// Without a projection, Pi's chat container renders its children in order.
		if (content || !this.fallback) {
			if (this.width <= 0) return undefined;
			const rows = new Map<Component, number>();
			let height = 0;
			for (const child of this.mode.chatContainer.children) {
				rows.set(child, height);
				height += child.render(this.width).length;
			}
			this.fallback = { height, rowOf: (component) => rows.get(component) };
		}
		return this.fallback;
	}

	private apply(): void {
		const { lo, hi } = this.window;
		const count = this.epochs.length;
		const prefix: Component[] = [];
		const retained = new Set<string>();
		// Only the fullscreen viewport loads on scroll; regular scrollback shows the default window.
		const scrolls = this.mode.ui.mode === "fullscreen";
		if (lo > 0) {
			this.earlier.text = `▲ ${plural(lo)} before this${scrolls ? " · scroll up to load" : ""}`;
			prefix.push(this.earlier);
		}
		for (let index = lo; index <= hi; index++) {
			const epoch = this.epochs[index]!;
			const page = this.pages.get(epoch.key) ?? this.build(epoch);
			this.pages.set(epoch.key, page);
			retained.add(epoch.key);
			prefix.push(page.start, ...page.components);
		}
		if (hi < count - 1) {
			this.later.text = `▼ ${plural(count - 1 - hi)} after this${scrolls ? " · scroll down to load" : ""}`;
			prefix.push(this.later);
		}
		for (const key of [...this.pages.keys()]) if (!retained.has(key)) this.pages.delete(key);
		this.removePrefix();
		const children = this.mode.chatContainer.children;
		children.splice(0, 0, ...prefix);
		this.owned = new Set(prefix);
		this.fallback = undefined;
		this.mode.ui.requestRender();
	}

	private removePrefix(): void {
		if (!this.owned.size) return;
		const children = this.mode.chatContainer.children;
		let write = 0;
		for (const child of children) if (!this.owned.has(child)) children[write++] = child;
		children.length = write;
		this.owned = new Set();
	}

	/** Render one epoch with Pi's own entry renderer into a detached container. */
	private build(epoch: TranscriptEpoch<SessionEntry>): Page {
		const mode = this.mode;
		const scratch = new Container();
		const chat = mode.chatContainer;
		const pendingTools: NativeValue = Reflect.get(mode, "pendingTools");
		const cacheWarmingNotice: NativeValue = Reflect.get(mode, "cacheWarmingNotice");
		// Pi's renderer resets live tool tracking and coalescing state; history must not disturb the live turn.
		Reflect.set(mode, "pendingTools", new Map());
		Reflect.set(mode, "chatContainer", scratch);
		try {
			this.renderEntries(mode, epoch.entries);
		} finally {
			Reflect.set(mode, "chatContainer", chat);
			Reflect.set(mode, "pendingTools", pendingTools);
			Reflect.set(mode, "cacheWarmingNotice", cacheWarmingNotice);
		}
		return { start: new PageStart((width) => this.rendered(width)), components: [...scratch.children] };
	}
}

function ensureBridge(): HistoryBridge | undefined {
	const prototype = InteractiveMode.prototype;
	const existing: NativeValue = Reflect.get(prototype, KEY);
	if (historyBridge(existing)) return existing;
	if (Reflect.get(prototype, LEGACY) !== undefined) return undefined;
	const render: NativeValue = Reflect.get(prototype, "renderSessionEntries");
	if (typeof render !== "function") return undefined;
	const hosts = new WeakMap<TUI, { count: number; options: TranscriptHistoryOptions | undefined }>();
	const windows = new WeakMap<TUI, HistoryWindow>();
	let leases = 0;
	const renderEntries = (mode: NativeMode, entries: readonly SessionEntry[]): void => {
		Reflect.apply(render, mode, [entries]);
	};
	const wrappedRender = function (this: object, ...args: NativeValue[]): void {
		const refresh: NativeValue = Reflect.get(this, "rebuildChatFromMessages");
		if (nativeMode(this) && typeof refresh === "function" && !historyOwner(Reflect.get(this.ui, OWNER))) {
			// Keep the owner for this TUI's lifetime: /resume and /reload render before session_start.
			const owner: HistoryOwner = { protocol: PROTOCOL, refresh: () => Reflect.apply(refresh, this, []) };
			Reflect.set(this.ui, OWNER, owner);
		}
		// Pi renders the model context; every chat rebuild ends here, so the history prefix is restored after it.
		Reflect.apply(render, this, args);
		if (!nativeMode(this)) return;
		const host = hosts.get(this.ui);
		if (!host) return;
		let window = windows.get(this.ui);
		if (!window) {
			window = new HistoryWindow(this, renderEntries);
			windows.set(this.ui, window);
		}
		window.theme = host.options?.theme;
		window.sync();
	};
	const bridge: HistoryBridge = {
		protocol: PROTOCOL,
		retain() {
			leases++;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (--leases) return;
				if (Reflect.get(prototype, "renderSessionEntries") === wrappedRender)
					Reflect.set(prototype, "renderSessionEntries", render);
				if (Reflect.get(prototype, KEY) === bridge) Reflect.deleteProperty(prototype, KEY);
			};
		},
		acquire(host, options) {
			const previous = hosts.get(host);
			hosts.set(host, { count: (previous?.count ?? 0) + 1, options: options ?? previous?.options });
			const release = bridge.retain();
			const owner: NativeValue = Reflect.get(host, OWNER);
			if (!previous && historyOwner(owner)) owner.refresh();
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const current = hosts.get(host);
				const remaining = (current?.count ?? 1) - 1;
				if (current && remaining) hosts.set(host, { ...current, count: remaining });
				else {
					hosts.delete(host);
					windows.get(host)?.dispose();
					windows.delete(host);
				}
				release();
			};
		},
	};
	Reflect.set(prototype, "renderSessionEntries", wrappedRender);
	Object.defineProperty(prototype, KEY, { configurable: true, value: bridge });
	return bridge;
}
