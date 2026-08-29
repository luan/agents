import { expect, test } from "bun:test";
import { ensureSidePanelRegistry, SIDE_PANEL_PROTOCOL, type SidePanelProvider } from "../src/side-panel.ts";

function provider(id: string, session: object = {}): SidePanelProvider {
	return { id, session, attach: () => undefined };
}

test("side-panel providers are load-order independent and identity safe", () => {
	const scope = Object.create(null) as typeof globalThis;
	const registry = ensureSidePanelRegistry(scope);
	const first = provider("review");
	const replacement = provider("review");

	expect(ensureSidePanelRegistry(scope)).toBe(registry);
	expect(registry.protocol).toBe(SIDE_PANEL_PROTOCOL);
	expect(registry.version).toBe(1);
	const removeFirst = registry.register(first);
	const removeReplacement = registry.register(replacement);
	removeFirst();
	expect(registry.providers()).toEqual([replacement]);
	removeReplacement();
	expect(registry.providers()).toEqual([]);
});

test("side-panel provider registration isolates optional listener failures", () => {
	const registry = ensureSidePanelRegistry(Object.create(null) as typeof globalThis);
	const attached: string[] = [];
	registry.onRegister(() => {
		throw new Error("broken optional host");
	});
	registry.onRegister((next) => attached.push(next.id));

	expect(() => registry.register(provider("chat"))).not.toThrow();
	expect(attached).toEqual(["chat"]);
});
