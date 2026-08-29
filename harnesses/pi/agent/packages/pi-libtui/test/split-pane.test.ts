import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import {
	ensureSplitPaneRegistry,
	mountSplitPane,
	SPLIT_PANE_PROTOCOL,
	type SplitPaneDefinition,
} from "../src/split-pane.ts";

// type-boundary: Runtime-validation fixtures deliberately cross the split-pane contribution boundary.
type InvalidDefinitionBoundary = unknown;

function component(label: string): Component {
	return {
		render: (width) => [`${label}:${width}`],
		invalidate() {},
	};
}

function definition(overrides: Partial<SplitPaneDefinition> = {}): SplitPaneDefinition {
	return {
		id: "test.pane",
		position: "right",
		component: () => component("pane"),
		size: 24,
		minMainSize: 40,
		...overrides,
	};
}

describe("split-pane registry", () => {
	test("is load-order independent and normalizes the active contribution", () => {
		const scope = Object.create(null) as typeof globalThis;
		const registry = ensureSplitPaneRegistry(scope);

		expect(ensureSplitPaneRegistry(scope)).toBe(registry);
		expect(registry.protocol).toBe(SPLIT_PANE_PROTOCOL);
		expect(registry.version).toBe(2);
		expect(registry.current()).toBeUndefined();

		const source = definition();
		const remove = mountSplitPane(source, scope);
		expect(registry.current()).toEqual({ ...source, gap: 1, priority: 0 });
		expect(registry.current()).not.toBe(source);

		remove();
		expect(registry.current()).toBeUndefined();
	});

	test("selects the highest priority and the latest mount among ties", () => {
		const registry = ensureSplitPaneRegistry(Object.create(null) as typeof globalThis);
		const changes: string[] = [];
		registry.subscribe(() => changes.push(registry.current()?.id ?? "none"));
		const removeHigh = registry.mount(definition({ id: "high", priority: 10 }));
		const removeLow = registry.mount(definition({ id: "low", priority: -1 }));
		const removeHighTie = registry.mount(definition({ id: "high-tie", priority: 10 }));

		expect(registry.current()?.id).toBe("high-tie");
		expect(changes).toEqual(["high", "high-tie"]);
		removeLow();
		expect(changes).toEqual(["high", "high-tie"]);
		removeHighTie();
		expect(registry.current()?.id).toBe("high");
		removeHigh();
		expect(changes).toEqual(["high", "high-tie", "high", "none"]);
	});

	test("uses the newest lease and reveals the previous pane when it is released", () => {
		const registry = ensureSplitPaneRegistry(Object.create(null) as typeof globalThis);
		const changes: Array<string | undefined> = [];
		registry.subscribe(() => changes.push(registry.current()?.id));
		const removeFirst = registry.mount(definition({ id: "first", position: "left", gap: 0 }));
		const first = registry.current();
		const removeSecond = registry.mount(definition({ id: "second", size: 30 }));

		expect(registry.current()?.id).toBe("second");
		removeFirst();
		expect(registry.current()?.id).toBe("second");
		expect(changes).toEqual(["first", "second"]);

		removeSecond();
		expect(registry.current()).toBeUndefined();
		expect(changes).toEqual(["first", "second", undefined]);

		// Disposers are identity-safe and idempotent even after another lease used the same id.
		const removeReplacement = registry.mount(definition({ id: "first", size: 18 }));
		removeFirst();
		expect(registry.current()?.size).toBe(18);
		removeReplacement();
		expect(first?.id).toBe("first");
	});

	test("notifies independent listeners and isolates listener failures", () => {
		const registry = ensureSplitPaneRegistry(Object.create(null) as typeof globalThis);
		const calls: string[] = [];
		registry.subscribe(() => {
			throw new Error("optional listener failed");
		});
		const unsubscribe = registry.subscribe(() => calls.push(registry.current()?.id ?? "none"));

		const remove = registry.mount(definition({ id: "visible" }));
		expect(calls).toEqual(["visible"]);
		unsubscribe();
		unsubscribe();
		remove();
		expect(calls).toEqual(["visible"]);
	});

	test("rejects malformed identifiers, positions, factories, and geometry", () => {
		const registry = ensureSplitPaneRegistry(Object.create(null) as typeof globalThis);
		const invalid: InvalidDefinitionBoundary[] = [
			definition({ id: "  " }),
			{ ...definition(), position: "top" },
			{ ...definition(), component: "not a factory" },
			definition({ size: 0 }),
			definition({ size: 1.5 }),
			definition({ initialRatio: 0 }),
			definition({ initialRatio: 1 }),
			definition({ initialRatio: Number.NaN }),
			{ ...definition(), onResize: "not a callback" },
			definition({ minMainSize: 0 }),
			definition({ minMainSize: Number.POSITIVE_INFINITY }),
			definition({ gap: -1 }),
			definition({ gap: 0.5 }),
			definition({ priority: 0.5 }),
			definition({ priority: Number.POSITIVE_INFINITY }),
		];

		for (const candidate of invalid) {
			expect(() => registry.mount(candidate as SplitPaneDefinition)).toThrow();
			expect(registry.current()).toBeUndefined();
		}
	});
});
