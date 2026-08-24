/** Process-wide capability for Vim-style transcript folding. */
export const FOLDING_REGISTRY_KEY = Symbol.for("pi-libtui/folding/registry/v2");
export const FOLDING_PROTOCOL = "pi-libtui/folding/registry/v2" as const;

export type FoldOperation = "open" | "close" | "open-all" | "close-all";
export const FOLD_TARGET_AT_ROW = Symbol.for("pi-libtui/folding/target-at-row/v1");

/** A visible component that can be opened and closed by a host interaction mode. */
export interface FoldTarget {
	/** Whether this target is currently closed. */
	isFolded(): boolean;
	/** Open this target. */
	open(): void;
	/** Close this target. */
	close(): void;
}

/** Structural component capability for resolving a fold from a rendered local row. */
export interface FoldTargetAtRow {
	readonly [FOLD_TARGET_AT_ROW]: (row: number) => FoldTarget | undefined;
}

/** Shared registry used by copy mode and other keyboard hosts. */
export interface FoldingRegistry {
	readonly protocol: typeof FOLDING_PROTOCOL;
	readonly version: 2;
	register(target: FoldTarget): () => void;
	setCurrent(target: FoldTarget | undefined): void;
	readonly current: FoldTarget | undefined;
	/** Whether this exact target is still registered with the current renderer. */
	has(target: FoldTarget): boolean;
	/** Apply one operation to an explicitly resolved target, or to pointer focus when omitted. */
	apply(operation: FoldOperation, target?: FoldTarget | null): boolean;
}

// type-boundary: Symbol.for state may come from another installed libtui realm; validate it before use.
type UntrustedValue = unknown;
type RegistryState = { targets: FoldTarget[]; current?: FoldTarget };
const states = new WeakMap<FoldingRegistry, RegistryState>();
const STATE_KEY = Symbol.for("pi-libtui/folding/registry-state/v2");

function isRecord(value: UntrustedValue): value is Record<PropertyKey, UntrustedValue> {
	return value !== null && typeof value === "object";
}

function isRegistry(value: UntrustedValue): value is FoldingRegistry {
	if (!isRecord(value)) return false;
	try {
		return (
			value.protocol === FOLDING_PROTOCOL &&
			value.version === 2 &&
			typeof value.register === "function" &&
			typeof value.setCurrent === "function" &&
			typeof value.has === "function" &&
			typeof value.apply === "function" &&
			stateOf(value) !== undefined
		);
	} catch {
		return false;
	}
}

function stateFor(registry: FoldingRegistry): RegistryState {
	const existing = states.get(registry);
	if (existing && isState(existing)) return existing;
	const shared = stateOf(registry);
	if (shared) {
		states.set(registry, shared);
		return shared;
	}
	const state: RegistryState = { targets: [] };
	try {
		Object.defineProperty(registry, STATE_KEY, { value: state, enumerable: false });
	} catch {
		// A malformed non-configurable state from another realm must not break local folding behavior.
	}
	states.set(registry, state);
	return state;
}

function stateOf(value: UntrustedValue): RegistryState | undefined {
	if (!isRecord(value)) return undefined;
	try {
		const state = Reflect.get(value, STATE_KEY) as UntrustedValue;
		return isState(state) ? state : undefined;
	} catch {
		return undefined;
	}
}

function isState(value: UntrustedValue): value is RegistryState {
	if (!isRecord(value) || !Array.isArray(value.targets) || !value.targets.every(isFoldTarget)) return false;
	return value.current === undefined || (isFoldTarget(value.current) && value.targets.includes(value.current));
}

function removeIdentity(values: FoldTarget[], value: FoldTarget): void {
	const index = values.indexOf(value);
	if (index >= 0) values.splice(index, 1);
}

function isFoldTarget(value: UntrustedValue): value is FoldTarget {
	if (!isRecord(value)) return false;
	try {
		return (
			typeof value.isFolded === "function" && typeof value.open === "function" && typeof value.close === "function"
		);
	} catch {
		return false;
	}
}

/** Resolve a registered fold target from a component-local rendered row. */
export function foldTargetAt(component: object, row: number): FoldTarget | undefined {
	if (!Number.isFinite(row) || row < 0) return undefined;
	const provider = Reflect.get(component, FOLD_TARGET_AT_ROW) as UntrustedValue;
	if (typeof provider !== "function") return undefined;
	try {
		const target = Reflect.apply(provider, component, [Math.floor(row)]) as UntrustedValue;
		return isFoldTarget(target) ? target : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve or create the process-wide folding registry. */
export function ensureFoldingRegistry(scope: typeof globalThis = globalThis): FoldingRegistry {
	const slots = scope as Record<PropertyKey, UntrustedValue>;
	const existing = slots[FOLDING_REGISTRY_KEY];
	if (isRegistry(existing)) {
		const state = stateOf(existing);
		if (state) states.set(existing, state);
		return existing;
	}
	const registry: FoldingRegistry = {
		protocol: FOLDING_PROTOCOL,
		version: 2,
		register(target) {
			const state = stateFor(registry);
			state.targets.push(target);
			return () => {
				removeIdentity(state.targets, target);
				if (state.current === target) state.current = undefined;
			};
		},
		setCurrent(target) {
			const state = stateFor(registry);
			state.current = target && state.targets.includes(target) ? target : undefined;
		},
		get current() {
			return stateFor(registry).current;
		},
		has(target) {
			return stateFor(registry).targets.includes(target);
		},
		apply(operation, target) {
			const state = stateFor(registry);
			const targets = operation.endsWith("-all")
				? [...state.targets]
				: target && state.targets.includes(target)
					? [target]
					: target === undefined && state.current
						? [state.current]
						: [];
			if (targets.length === 0) return false;
			const open = operation === "open" || operation === "open-all";
			let applied = false;
			for (const target of targets) {
				try {
					if (open) target.open();
					else target.close();
					applied = true;
				} catch {
					// A feature-owned fold must not take down copy mode.
				}
			}
			return applied;
		},
	};
	stateFor(registry);
	slots[FOLDING_REGISTRY_KEY] = registry;
	return registry;
}

/**
 * Clear a target only when it still owns the current pointer/focus slot.
 * Leave/focus-out events can arrive after another target has already become
 * current, so an old component must not clear the newer row.
 */
export function clearFoldingCurrent(target: FoldTarget, scope: typeof globalThis = globalThis): void {
	const registry = ensureFoldingRegistry(scope);
	if (registry.current === target) registry.setCurrent(undefined);
}
