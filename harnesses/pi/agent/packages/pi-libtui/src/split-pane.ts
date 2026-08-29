import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "./mouse/events.ts";

export const SPLIT_PANE_REGISTRY_KEY = Symbol.for("pi-libtui/split-panes/v2");
export const SPLIT_PANE_PROTOCOL = "pi-libtui/split-panes/v2" as const;

export type SplitPanePosition = "left" | "right";
export type SplitPaneComponent = Component & {
	/** The component already enforces the width passed to render. */
	readonly rendersWithinWidth?: true;
	/** Whether this input can only change the component after later asynchronous output. */
	defersInputRender?(data: string): boolean;
	onMouse?(event: TuiMouseEvent): boolean;
	/** Return false while this pane should remain pointer- and action-interactive without taking keyboard focus. */
	acceptsFocus?(): boolean;
	dispose?(): void;
};

/** Renderer access available to a split-pane component. */
export interface SplitPaneHost {
	/** The active fullscreen renderer. */
	readonly tui: TUI;
	/** Current pane viewport size. Falls back to the renderer size until layout geometry exists. */
	getTerminalSize(): { columns: number; rows: number };
	requestRender(): void;
	/** Focus this pane, remembering the component that should regain focus. */
	focus(): void;
	/** Restore the remembered focus target when this pane still owns focus. */
	blur(): void;
	/** Whether this pane currently receives terminal input. */
	isFocused(): boolean;
}

export type SplitPaneComponentFactory = (host: SplitPaneHost, theme: Theme) => SplitPaneComponent;

/** One optional pane composed beside Pi's complete fullscreen layout. */
export interface SplitPaneDefinition {
	/** Stable diagnostic identity for the contribution. */
	readonly id: string;
	/** Side of Pi's main pane. */
	readonly position: SplitPanePosition;
	/** Component created separately for each fullscreen renderer. */
	readonly component: SplitPaneComponentFactory;
	/** Initial pane width in terminal cells. */
	readonly size: number;
	/** Initial share of the terminal width when no committed size has been restored. */
	readonly initialRatio?: number;
	/** Called once when a pointer resize is committed. */
	readonly onResize?: (size: number) => void;
	/** Minimum width reserved for Pi's main pane. */
	readonly minMainSize: number;
	/** Empty cells beside the draggable border. Defaults to one. */
	readonly gap?: number;
	/** Visibility priority. Highest wins; the latest mount wins ties. Defaults to zero. */
	readonly priority?: number;
}

/** Validated split-pane definition stored by the shared registry. */
export interface MountedSplitPane extends Omit<SplitPaneDefinition, "gap" | "priority"> {
	readonly gap: number;
	readonly priority: number;
}

export interface SplitPaneRegistry {
	readonly protocol: typeof SPLIT_PANE_PROTOCOL;
	readonly version: 2;
	mount(definition: SplitPaneDefinition): () => void;
	current(): MountedSplitPane | undefined;
	subscribe(listener: () => void): () => void;
}

interface SplitPaneRegistryState {
	readonly panes: MountedSplitPane[];
	readonly listeners: Array<() => void>;
}

const STATE_KEY = Symbol.for("pi-libtui/split-panes/state/v2");
const states = new WeakMap<SplitPaneRegistry, SplitPaneRegistryState>();

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the public methods.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is SplitPaneRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SplitPaneRegistry>;
	return (
		candidate.protocol === SPLIT_PANE_PROTOCOL &&
		candidate.version === 2 &&
		typeof candidate.mount === "function" &&
		typeof candidate.current === "function" &&
		typeof candidate.subscribe === "function"
	);
}

function isState(value: UntrustedRegistryValue): value is SplitPaneRegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SplitPaneRegistryState>;
	return Array.isArray(candidate.panes) && Array.isArray(candidate.listeners);
}

function stateFor(registry: SplitPaneRegistry): SplitPaneRegistryState {
	const cached = states.get(registry);
	if (cached) return cached;
	const shared = Reflect.get(registry as object, STATE_KEY) as UntrustedRegistryValue;
	if (isState(shared)) {
		states.set(registry, shared);
		return shared;
	}
	const state: SplitPaneRegistryState = { panes: [], listeners: [] };
	Object.defineProperty(registry, STATE_KEY, { configurable: false, enumerable: false, value: state });
	states.set(registry, state);
	return state;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
	return value;
}

function integer(value: number, name: string): number {
	if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`);
	return value;
}

function normalized(definition: SplitPaneDefinition): MountedSplitPane {
	if (definition.id.trim().length === 0) throw new TypeError("split pane id must not be empty");
	if (definition.position !== "left" && definition.position !== "right") {
		throw new TypeError('split pane position must be "left" or "right"');
	}
	if (typeof definition.component !== "function") throw new TypeError("split pane component must be a factory");
	const size = positiveInteger(definition.size, "split pane size");
	if (
		definition.initialRatio !== undefined &&
		(!Number.isFinite(definition.initialRatio) || definition.initialRatio <= 0 || definition.initialRatio >= 1)
	) {
		throw new RangeError("split pane initial ratio must be between zero and one");
	}
	if (definition.onResize !== undefined && typeof definition.onResize !== "function") {
		throw new TypeError("split pane resize callback must be a function");
	}
	return {
		id: definition.id,
		position: definition.position,
		component: definition.component,
		size,
		...(definition.initialRatio === undefined ? {} : { initialRatio: definition.initialRatio }),
		...(definition.onResize === undefined ? {} : { onResize: definition.onResize }),
		minMainSize: positiveInteger(definition.minMainSize, "split pane minimum main size"),
		gap: nonNegativeInteger(definition.gap ?? 1, "split pane gap"),
		priority: integer(definition.priority ?? 0, "split pane priority"),
	};
}

function currentPane(state: SplitPaneRegistryState): MountedSplitPane | undefined {
	let selected: MountedSplitPane | undefined;
	for (const pane of state.panes) {
		if (!selected || pane.priority >= selected.priority) selected = pane;
	}
	return selected;
}

function removeIdentity<T>(values: T[], value: T): boolean {
	const index = values.indexOf(value);
	if (index < 0) return false;
	values.splice(index, 1);
	return true;
}

function notify(state: SplitPaneRegistryState): void {
	for (const listener of [...state.listeners]) {
		try {
			listener();
		} catch {
			// Optional consumers must not break other split-pane contributions.
		}
	}
}

/** Resolve or create the process-wide split-pane registry. */
export function ensureSplitPaneRegistry(scope: typeof globalThis = globalThis): SplitPaneRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[SPLIT_PANE_REGISTRY_KEY];
	if (isRegistry(existing)) {
		stateFor(existing);
		return existing;
	}
	const registry: SplitPaneRegistry = {
		protocol: SPLIT_PANE_PROTOCOL,
		version: 2,
		mount(definition) {
			const pane = normalized(definition);
			const state = stateFor(registry);
			const previous = currentPane(state);
			state.panes.push(pane);
			if (currentPane(state) !== previous) notify(state);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				const previous = currentPane(state);
				if (removeIdentity(state.panes, pane) && currentPane(state) !== previous) notify(state);
			};
		},
		current() {
			return currentPane(stateFor(registry));
		},
		subscribe(listener) {
			const state = stateFor(registry);
			state.listeners.push(listener);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				removeIdentity(state.listeners, listener);
			};
		},
	};
	stateFor(registry);
	slots[SPLIT_PANE_REGISTRY_KEY] = registry;
	return registry;
}

/** Mount one pane beside Pi's fullscreen layout until the returned lease is disposed. */
export function mountSplitPane(definition: SplitPaneDefinition, scope: typeof globalThis): () => void {
	return ensureSplitPaneRegistry(scope).mount(definition);
}
