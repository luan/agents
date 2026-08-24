import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONTEXT_WINDOW_PRESETS = ["smart", "balanced", "enhanced", "large", "max"] as const;
export type ContextWindowPreset = (typeof CONTEXT_WINDOW_PRESETS)[number];
export const CONTEXT_WINDOW_PREFERENCES = ["default", ...CONTEXT_WINDOW_PRESETS] as const;
export type ContextWindowPreference = (typeof CONTEXT_WINDOW_PREFERENCES)[number];

export function isContextWindowPreset(value: unknown): value is ContextWindowPreset {
	return typeof value === "string" && CONTEXT_WINDOW_PRESETS.includes(value as ContextWindowPreset);
}

export const CONTEXT_WINDOW_SOURCES_KEY = Symbol.for("pi-libcontext/sources/v1");
export const CONTEXT_WINDOW_SOURCES_PROTOCOL = "pi-libcontext/sources/v1" as const;

export interface ContextWindowSource {
	id: string;
	preset(ctx: ExtensionContext): ContextWindowPreset | undefined;
}

export interface ContextWindowSourceRegistry {
	readonly protocol: typeof CONTEXT_WINDOW_SOURCES_PROTOCOL;
	readonly version: 1;
	register(source: ContextWindowSource): () => void;
}

type RegistryState = { sources: Map<ContextWindowSource, ContextWindowSource> };
const STATE_KEY = Symbol.for("pi-libcontext/sources-state/v1");
const states = new WeakMap<ContextWindowSourceRegistry, RegistryState>();

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the public methods.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is ContextWindowSourceRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ContextWindowSourceRegistry>;
	return (
		candidate.protocol === CONTEXT_WINDOW_SOURCES_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.register === "function"
	);
}

function stateFor(registry: ContextWindowSourceRegistry): RegistryState {
	const existing = states.get(registry);
	if (existing) return existing;
	const shared = Reflect.get(registry as object, STATE_KEY) as UntrustedRegistryValue;
	if (isState(shared)) {
		states.set(registry, shared);
		return shared;
	}
	const state: RegistryState = { sources: new Map() };
	Object.defineProperty(registry, STATE_KEY, { value: state, enumerable: false, configurable: false });
	states.set(registry, state);
	return state;
}

function isState(value: UntrustedRegistryValue): value is RegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RegistryState>;
	return isMap(candidate.sources);
}

function isMap(value: UntrustedRegistryValue): value is Map<never, never> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		values?: UntrustedRegistryValue;
		set?: UntrustedRegistryValue;
		delete?: UntrustedRegistryValue;
	};
	return (
		typeof candidate.values === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function"
	);
}

export function ensureContextWindowSourceRegistry(scope: typeof globalThis = globalThis): ContextWindowSourceRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[CONTEXT_WINDOW_SOURCES_KEY];
	if (isRegistry(existing)) return existing;
	const registry: ContextWindowSourceRegistry = {
		protocol: CONTEXT_WINDOW_SOURCES_PROTOCOL,
		version: 1,
		register(source) {
			const state = stateFor(registry);
			state.sources.set(source, source);
			return () => {
				state.sources.delete(source);
			};
		},
	};
	stateFor(registry);
	slots[CONTEXT_WINDOW_SOURCES_KEY] = registry;
	return registry;
}

export function requestedContextWindowPreset(ctx: ExtensionContext): ContextWindowPreset | undefined {
	const registry = ensureContextWindowSourceRegistry();
	const state = stateFor(registry);
	for (const source of state.sources.values()) {
		try {
			const preset = source.preset(ctx);
			if (isContextWindowPreset(preset)) return preset;
		} catch {
			// Optional contributors must not affect provider lifecycle.
		}
	}
	return undefined;
}
