import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ACTIONS_REGISTRY_KEY = Symbol.for("pi-libactions/registry/v1");
export const ACTIONS_PROTOCOL = "pi-libactions/registry/v1" as const;

export interface ActionRegistration {
	id: string;
	description: string;
	run(ctx: ExtensionContext): void | Promise<void>;
}

export interface ActionsRegistry {
	readonly protocol: typeof ACTIONS_PROTOCOL;
	readonly version: 1;
	register(action: ActionRegistration): () => void;
	onRegister(listener: (action: ActionRegistration) => void): () => void;
	find(id: string): ActionRegistration | undefined;
}

type RegistryState = {
	actions: Map<string, ActionRegistration>;
	listeners: Set<(action: ActionRegistration) => void>;
};

const STATE_KEY = Symbol.for("pi-libactions/registry-state/v1");
const states = new WeakMap<ActionsRegistry, RegistryState>();

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the public methods.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is ActionsRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ActionsRegistry>;
	return (
		candidate.protocol === ACTIONS_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.register === "function" &&
		typeof candidate.onRegister === "function" &&
		typeof candidate.find === "function"
	);
}

function stateFor(registry: ActionsRegistry): RegistryState {
	const existing = states.get(registry);
	if (existing) return existing;
	const shared = Reflect.get(registry as object, STATE_KEY) as UntrustedRegistryValue;
	if (isState(shared)) {
		states.set(registry, shared);
		return shared;
	}
	const state: RegistryState = { actions: new Map(), listeners: new Set() };
	Object.defineProperty(registry, STATE_KEY, { value: state, enumerable: false, configurable: false });
	states.set(registry, state);
	return state;
}

function isState(value: UntrustedRegistryValue): value is RegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RegistryState>;
	return isMap(candidate.actions) && isSet(candidate.listeners);
}

function isMap(value: UntrustedRegistryValue): value is Map<never, never> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		get?: UntrustedRegistryValue;
		set?: UntrustedRegistryValue;
		delete?: UntrustedRegistryValue;
	};
	return (
		typeof candidate.get === "function" && typeof candidate.set === "function" && typeof candidate.delete === "function"
	);
}

function isSet(value: UntrustedRegistryValue): value is Set<never> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { add?: UntrustedRegistryValue; delete?: UntrustedRegistryValue };
	return typeof candidate.add === "function" && typeof candidate.delete === "function";
}

export function ensureActionsRegistry(scope: typeof globalThis = globalThis): ActionsRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[ACTIONS_REGISTRY_KEY];
	if (isRegistry(existing)) return existing;

	const registry: ActionsRegistry = {
		protocol: ACTIONS_PROTOCOL,
		version: 1,
		register(action) {
			const state = stateFor(registry);
			state.actions.set(action.id, action);
			for (const listener of [...state.listeners]) {
				try {
					listener(action);
				} catch {
					// Optional action consumers must not affect registration.
				}
			}
			return () => {
				if (state.actions.get(action.id) === action) state.actions.delete(action.id);
			};
		},
		onRegister(listener) {
			const state = stateFor(registry);
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		find(id) {
			return stateFor(registry).actions.get(id);
		},
	};
	stateFor(registry);
	slots[ACTIONS_REGISTRY_KEY] = registry;
	return registry;
}

export function registerAction(action: ActionRegistration): () => void {
	try {
		return ensureActionsRegistry().register(action);
	} catch {
		return () => {};
	}
}
