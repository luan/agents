import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
	clearFoldingCurrent,
	ensureFoldingRegistry,
	FOLD_TARGET_AT_ROW,
	FOLDING_REGISTRY_KEY,
	type FoldingRegistry,
	type FoldTarget,
	foldTargetAt,
} from "../src/folding.ts";

function target(): FoldTarget & { openCount: number; closeCount: number; folded: boolean } {
	return {
		folded: true,
		openCount: 0,
		closeCount: 0,
		isFolded() {
			return this.folded;
		},
		open() {
			this.folded = false;
			this.openCount += 1;
		},
		close() {
			this.folded = true;
			this.closeCount += 1;
		},
	};
}

test("applies Vim fold operations to an explicitly resolved target and all registered targets", () => {
	const registry = ensureFoldingRegistry({} as typeof globalThis);
	const first = target();
	const second = target();
	const removeFirst = registry.register(first);
	const removeSecond = registry.register(second);
	expect(registry.apply("open", first)).toBe(true);
	expect(first.folded).toBe(false);
	expect(second.folded).toBe(true);
	expect(registry.apply("close-all")).toBe(true);
	expect(first.closeCount).toBe(1);
	expect(second.closeCount).toBe(1);
	expect(registry.apply("open-all")).toBe(true);
	expect(first.openCount).toBe(2);
	expect(second.openCount).toBe(1);

	removeFirst();
	removeSecond();
	expect(registry.apply("open")).toBe(false);
});

test("reuses structurally valid hidden state from another JavaScript realm", () => {
	// type-boundary: node:vm returns values from an isolated realm; the folding registry validator narrows it.
	type ForeignRealmValue = unknown;
	const foreignRegistry = runInNewContext(`
		const state = { targets: [], current: undefined };
		const registry = {
			protocol: "pi-libtui/folding/registry/v2",
			version: 2,
			register(target) { state.targets.push(target); return () => state.targets.splice(state.targets.indexOf(target), 1); },
			setCurrent(target) { state.current = state.targets.includes(target) ? target : undefined; },
			get current() { return state.current; },
			has(target) { return state.targets.includes(target); },
			apply(operation, target) {
				const targets = operation.endsWith("-all") ? [...state.targets] : target ? [target] : state.current ? [state.current] : [];
				for (const item of targets) operation.startsWith("open") ? item.open() : item.close();
				return targets.length > 0;
			},
		};
		Object.defineProperty(registry, Symbol.for("pi-libtui/folding/registry-state/v2"), { value: state });
		registry;
	`) as ForeignRealmValue as FoldingRegistry;
	const scope = Object.create(null) as Record<PropertyKey, ForeignRealmValue>;
	scope[FOLDING_REGISTRY_KEY] = foreignRegistry;
	const registry = ensureFoldingRegistry(scope as typeof globalThis);
	const owned = target();

	registry.register(owned);
	expect(registry).toBe(foreignRegistry);
	expect(registry.apply("open-all")).toBe(true);
	expect(owned.folded).toBe(false);
});

test("replaces a compatible-looking registry with malformed hidden state", () => {
	const scope = Object.create(null) as Record<PropertyKey, unknown>;
	const malformed = {
		protocol: "pi-libtui/folding/registry/v2",
		version: 2,
		register: () => () => {},
		setCurrent() {},
		has: () => false,
		apply: () => false,
	};
	Object.defineProperty(malformed, Symbol.for("pi-libtui/folding/registry-state/v2"), {
		value: { targets: [null] },
	});
	scope[FOLDING_REGISTRY_KEY] = malformed;

	const registry = ensureFoldingRegistry(scope as typeof globalThis);
	expect(registry).not.toBe(malformed);
	expect(registry.apply("open-all")).toBe(false);
});

test("never guesses a current row from registration order", () => {
	const registry = ensureFoldingRegistry({} as typeof globalThis);
	const first = target();
	const second = target();
	const removeFirst = registry.register(first);
	const removeSecond = registry.register(second);
	expect(registry.current).toBeUndefined();
	expect(registry.apply("open")).toBe(false);
	expect(first.openCount).toBe(0);
	expect(second.openCount).toBe(0);
	removeFirst();
	removeSecond();
});

test("resolves a fold only through explicit rendered-row ownership", () => {
	const owned = target();
	const component = {
		[FOLD_TARGET_AT_ROW](row: number) {
			return row === 2 ? owned : undefined;
		},
	};
	expect(foldTargetAt(component, 2)).toBe(owned);
	expect(foldTargetAt(component, 1)).toBeUndefined();
	expect(foldTargetAt({}, 2)).toBeUndefined();
});

test("clears only the target that still owns the current row", () => {
	const scope = {} as typeof globalThis;
	const registry = ensureFoldingRegistry(scope);
	const first = target();
	const second = target();
	const removeFirst = registry.register(first);
	const removeSecond = registry.register(second);

	registry.setCurrent(second);
	clearFoldingCurrent(first, scope);
	expect(registry.current).toBe(second);
	clearFoldingCurrent(second, scope);
	expect(registry.current).toBeUndefined();

	removeFirst();
	removeSecond();
});
