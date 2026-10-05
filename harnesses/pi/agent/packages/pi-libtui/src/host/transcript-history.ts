import {
	type AgentSessionEvent,
	InteractiveMode,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const PROTOCOL = "pi-libtui/transcript-history/v1" as const;
const KEY = Symbol.for(PROTOCOL);
const OWNER = Symbol.for(`${PROTOCOL}/owner`);
interface HistoryBridge {
	readonly protocol: typeof PROTOCOL;
	retain(): () => void;
	acquire(tui: TUI): () => void;
}
interface HistoryOwner {
	readonly protocol: typeof PROTOCOL;
	refresh(): void;
}
interface NativeMode {
	ui: TUI;
	sessionManager: Pick<SessionManager, "getBranch">;
	footer: { invalidate(): void };
}
interface RenderOptions {
	updateFooter?: boolean;
	populateHistory?: boolean;
}
// type-boundary: Pi 1.0's private transcript methods and cross-copy leases; the guards below validate them before use.
type NativeValue = unknown;
function record(value: NativeValue): value is Record<string, NativeValue> {
	return value !== null && typeof value === "object";
}
function nativeMode(value: NativeValue): value is NativeMode {
	return (
		record(value) &&
		record(value.ui) &&
		typeof value.ui.requestRender === "function" &&
		record(value.sessionManager) &&
		typeof value.sessionManager.getBranch === "function" &&
		record(value.footer) &&
		typeof value.footer.invalidate === "function"
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

/** Keep display history separate from model context. Replace when Pi exposes a transcript-history API. */
export function installTranscriptHistory(tui: TUI): () => void {
	return ensureBridge()?.acquire(tui) ?? (() => {});
}

/** Prepare before Pi restores history on reload; session_start attaches the TUI afterwards. */
export function retainTranscriptHistory(): () => void {
	return ensureBridge()?.retain() ?? (() => {});
}

function ensureBridge(): HistoryBridge | undefined {
	const prototype = InteractiveMode.prototype;
	const existing: NativeValue = Reflect.get(prototype, KEY);
	if (historyBridge(existing)) return existing;
	const handle: NativeValue = Reflect.get(prototype, "handleEvent");
	const render: NativeValue = Reflect.get(prototype, "renderSessionEntries");
	if (typeof handle !== "function" || typeof render !== "function") return undefined;
	const hosts = new WeakMap<object, number>();
	let leases = 0;
	const renderEntries = (mode: NativeMode, entries: readonly SessionEntry[], options?: RenderOptions): void => {
		Reflect.apply(render, mode, [entries, options]);
	};
	const appendCompaction = (mode: NativeMode, entry: SessionEntry): void => {
		renderEntries(mode, [entry]);
		mode.footer.invalidate();
		mode.ui.requestRender();
	};
	const wrappedRender = function (this: object, entries: readonly SessionEntry[], options?: RenderOptions): void {
		const refresh: NativeValue = Reflect.get(this, "rebuildChatFromMessages");
		if (nativeMode(this) && typeof refresh === "function" && !historyOwner(Reflect.get(this.ui, OWNER))) {
			// Keep the owner for this TUI's lifetime: /resume and /reload render before session_start.
			const owner: HistoryOwner = { protocol: PROTOCOL, refresh: () => Reflect.apply(refresh, this, []) };
			Reflect.set(this.ui, OWNER, owner);
		}
		// Outside compaction, Pi calls this only for initial load and history rebuilds.
		if (nativeMode(this) && hosts.has(this.ui)) renderEntries(this, this.sessionManager.getBranch(), options);
		else Reflect.apply(render, this, [entries, options]);
	};
	const wrappedHandle = function (this: object, event: AgentSessionEvent): Promise<void> {
		if (!nativeMode(this) || !hosts.has(this.ui)) return Reflect.apply(handle, this, [event]);
		if (event.type === "entry_appended" && event.entry.type === "compaction") {
			// Boundary-hook entries arrive chronologically; following entries still render through Pi.
			appendCompaction(this, event.entry);
			return Promise.resolve();
		}
		if (event.type === "compaction_end" && event.result && !event.aborted) {
			const entry = this.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction")
				.at(-1);
			if (!entry) return Reflect.apply(handle, this, [event]);
			appendCompaction(this, entry);
			// Keep Pi's status cleanup, queued input, errors, and retry lifecycle; skip only its successful rebuild.
			return Reflect.apply(handle, this, [{ ...event, result: undefined }]);
		}
		return Reflect.apply(handle, this, [event]);
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
				if (Reflect.get(prototype, "handleEvent") === wrappedHandle) Reflect.set(prototype, "handleEvent", handle);
				if (Reflect.get(prototype, "renderSessionEntries") === wrappedRender)
					Reflect.set(prototype, "renderSessionEntries", render);
				if (Reflect.get(prototype, KEY) === bridge) Reflect.deleteProperty(prototype, KEY);
			};
		},
		acquire(host) {
			const previous = hosts.get(host) ?? 0;
			hosts.set(host, previous + 1);
			const release = bridge.retain();
			const owner: NativeValue = Reflect.get(host, OWNER);
			if (!previous && historyOwner(owner)) owner.refresh();
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				const remaining = (hosts.get(host) ?? 1) - 1;
				if (remaining) hosts.set(host, remaining);
				else hosts.delete(host);
				release();
			};
		},
	};
	Reflect.set(prototype, "handleEvent", wrappedHandle);
	Reflect.set(prototype, "renderSessionEntries", wrappedRender);
	Object.defineProperty(prototype, KEY, { configurable: true, value: bridge });
	return bridge;
}
