export const SELECTION_REGISTRY_KEY = Symbol.for("pi-libtui/selection/v1");
export const SELECTION_PROTOCOL = "pi-libtui/selection/v1" as const;

export interface SelectionPoint {
	row: number;
	col: number;
}

export type SelectionShape = "character" | "line" | "column";
export type MessageIdStability = "stable" | "best-effort";

export interface SelectionOffsetRange {
	start: number;
	end: number;
}

export interface SelectionQuoteAnchor {
	exact: string;
	prefix?: string;
	suffix?: string;
}

export interface SelectionSourceAnchor {
	messageId?: string;
	messageIdStability?: MessageIdStability;
	offsets?: SelectionOffsetRange;
	quote?: SelectionQuoteAnchor;
}

export interface NativeSelectionGeometry {
	shape: SelectionShape;
	logical: { start: SelectionPoint; end: SelectionPoint };
	screen: { start: SelectionPoint; end: SelectionPoint };
}

export interface NativeSelectionCompleted extends NativeSelectionGeometry {
	text: string;
	source?: SelectionSourceAnchor;
}

export type SelectionCompletedListener = (selection: NativeSelectionCompleted) => void;
export interface SelectionActionRequest extends NativeSelectionCompleted {
	action: string;
	/** Screen position used to anchor an action overlay, independent of the selected range. */
	screenAnchor?: SelectionPoint;
	/** Ask the selection host to display cursor-local feedback without writing into the transcript. */
	showFeedback?(feedback: { message: string; kind: "success" | "warning" }): void;
}
export type SelectionActionResult = boolean;
export type SelectionActionListener = (
	request: SelectionActionRequest,
) => SelectionActionResult | undefined | Promise<SelectionActionResult | undefined>;

export interface SelectionRegistry {
	readonly protocol: typeof SELECTION_PROTOCOL;
	readonly version: 1;
	onSelectionCompleted(listener: SelectionCompletedListener): () => void;
	publishSelectionCompleted(selection: NativeSelectionCompleted): void;
	onSelectionAction(listener: SelectionActionListener): () => void;
	publishSelectionAction(request: SelectionActionRequest): Promise<SelectionActionResult>;
}

type RegistryState = { listeners: Set<SelectionCompletedListener>; actionListeners: Set<SelectionActionListener> };
const STATE_KEY = Symbol.for("pi-libtui/selection-state/v1");
const states = new WeakMap<SelectionRegistry, RegistryState>();

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the public methods.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is SelectionRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SelectionRegistry>;
	return (
		candidate.protocol === SELECTION_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.onSelectionCompleted === "function" &&
		typeof candidate.publishSelectionCompleted === "function" &&
		typeof candidate.onSelectionAction === "function" &&
		typeof candidate.publishSelectionAction === "function"
	);
}

function stateFor(registry: SelectionRegistry): RegistryState {
	const existing = states.get(registry);
	if (existing) return existing;
	const shared = Reflect.get(registry as object, STATE_KEY) as UntrustedRegistryValue;
	if (isState(shared)) {
		states.set(registry, shared);
		return shared;
	}
	const state = {
		listeners: new Set<SelectionCompletedListener>(),
		actionListeners: new Set<SelectionActionListener>(),
	};
	Object.defineProperty(registry, STATE_KEY, { value: state, enumerable: false, configurable: false });
	states.set(registry, state);
	return state;
}

function isState(value: UntrustedRegistryValue): value is RegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RegistryState>;
	return isSet(candidate.listeners) && isSet(candidate.actionListeners);
}

function isSet(value: UntrustedRegistryValue): value is Set<never> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { add?: UntrustedRegistryValue; delete?: UntrustedRegistryValue };
	return typeof candidate.add === "function" && typeof candidate.delete === "function";
}

export function ensureSelectionRegistry(scope: typeof globalThis = globalThis): SelectionRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[SELECTION_REGISTRY_KEY];
	if (isRegistry(existing)) return existing;
	const registry: SelectionRegistry = {
		protocol: SELECTION_PROTOCOL,
		version: 1,
		onSelectionCompleted(listener) {
			const state = stateFor(registry);
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		publishSelectionCompleted(selection) {
			for (const listener of [...stateFor(registry).listeners]) {
				try {
					listener(selection);
				} catch {
					// Optional listeners must not affect native selection or clipboard behavior.
				}
			}
		},
		onSelectionAction(listener) {
			const state = stateFor(registry);
			state.actionListeners.add(listener);
			return () => state.actionListeners.delete(listener);
		},
		async publishSelectionAction(request) {
			const results = await Promise.allSettled(
				[...stateFor(registry).actionListeners].map((listener) => Promise.resolve().then(() => listener(request))),
			);
			return results.some((result) => result.status === "fulfilled" && result.value === true);
		},
	};
	stateFor(registry);
	slots[SELECTION_REGISTRY_KEY] = registry;
	return registry;
}
