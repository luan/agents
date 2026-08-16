import { afterEach, expect, test } from "bun:test";
import extension from "./index.ts";
import { getToolPolicy, unpublishToolPolicy } from "./policy.ts";

type Handler = (...args: any[]) => unknown;

function createPi() {
	const hooks = new Map<string, Handler[]>();
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const activeTools = ["exec", "read"];
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		on(event: string, handler: Handler) {
			hooks.set(event, [...(hooks.get(event) ?? []), handler]);
		},
		events: {
			on(channel: string, listener: (value: unknown) => void) {
				const channelListeners = listeners.get(channel) ?? new Set();
				channelListeners.add(listener);
				listeners.set(channel, channelListeners);
				return () => channelListeners.delete(listener);
			},
			emit(channel: string, value: unknown) {
				for (const listener of listeners.get(channel) ?? []) listener(value);
			},
		},
	};
	return { pi, hooks };
}

function sessionContext(id: string) {
	return { sessionManager: { getSessionId: () => id } };
}

afterEach(() => {
	unpublishToolPolicy("policy-root");
	unpublishToolPolicy("policy-child");
});

test("publishes and removes each session policy independently", () => {
	const root = createPi();
	const child = createPi();
	extension(root.pi as never);
	extension(child.pi as never);

	for (const handler of root.hooks.get("session_start") ?? []) handler({}, sessionContext("policy-root"));
	for (const handler of child.hooks.get("session_start") ?? []) handler({}, sessionContext("policy-child"));

	const rootPolicy = getToolPolicy("policy-root");
	const childPolicy = getToolPolicy("policy-child");
	expect(rootPolicy).toBeDefined();
	expect(childPolicy).toBeDefined();
	expect(rootPolicy).not.toBe(childPolicy);

	for (const handler of child.hooks.get("session_shutdown") ?? []) handler({}, sessionContext("policy-child"));

	expect(getToolPolicy("policy-root")).toBe(rootPolicy);
	expect(getToolPolicy("policy-child")).toBeUndefined();

	for (const handler of root.hooks.get("session_shutdown") ?? []) handler({}, sessionContext("policy-root"));
});
