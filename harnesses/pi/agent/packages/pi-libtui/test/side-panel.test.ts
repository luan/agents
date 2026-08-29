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

test("side-panel host attaches providers in either load order and owns their lifecycle", () => {
	const registry = ensureSidePanelRegistry(Object.create(null) as typeof globalThis);
	const attached: string[] = [];
	const detached: string[] = [];
	const session = {};
	const host = registry.installHost();
	const detachHost = host.attach(session, {} as never, () => {});
	const removeChat = registry.register({
		id: "chat",
		session,
		attach: () => {
			attached.push("chat");
			return () => detached.push("chat");
		},
	});
	const removeOther = registry.register({
		id: "other",
		session: {},
		attach: () => {
			attached.push("other");
		},
	});

	expect(registry.hasHost()).toBe(true);
	expect(attached).toEqual(["chat"]);
	removeChat();
	expect(detached).toEqual(["chat"]);
	removeOther();
	detachHost();
	host.dispose();
	expect(registry.hasHost()).toBe(false);
});

test("side-panel host isolates provider failures and attaches providers registered first", () => {
	const registry = ensureSidePanelRegistry(Object.create(null) as typeof globalThis);
	const session = {};
	const errors: string[] = [];
	const remove = registry.register({
		id: "broken",
		session,
		attach: () => {
			throw new Error("broken provider");
		},
	});
	const host = registry.installHost();
	expect(() => host.attach(session, {} as never, (provider) => errors.push(provider.id))).not.toThrow();
	expect(errors).toEqual(["broken"]);
	remove();
	host.dispose();
});
