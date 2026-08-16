import { expect, test } from "bun:test";
import { registerCodeModePreflightBroker, registerCodeModeToolPreflight } from "./nested-tool-preflight.ts";

function extensionApi() {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	return {
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
		on() {},
	};
}

test("a registered preflight blocks a nested tool before execution", async () => {
	const pi = extensionApi();
	const broker = registerCodeModePreflightBroker(pi as never);
	const registration = registerCodeModeToolPreflight(pi as never, (call) =>
		call.toolName === "write" ? { block: true, reason: "blocked by test policy" } : undefined,
	);

	expect(registration.available).toBe(true);
	await expect(
		broker.run({
			toolName: "write",
			input: { path: "blocked.txt" },
			toolCallId: "call-1",
			cwd: process.cwd(),
			extensionContext: {} as never,
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("blocked by test policy");
});

test("a live preflight registers when its extension loads before the broker", async () => {
	const pi = extensionApi();
	const registration = registerCodeModeToolPreflight(pi as never, () => ({ block: true, reason: "live block" }));
	expect(registration.available).toBe(false);

	const broker = registerCodeModePreflightBroker(pi as never);

	expect(registration.available).toBe(true);
	await expect(
		broker.run({
			toolName: "write",
			input: {},
			toolCallId: "call-2",
			cwd: process.cwd(),
			extensionContext: {} as never,
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("live block");
});
