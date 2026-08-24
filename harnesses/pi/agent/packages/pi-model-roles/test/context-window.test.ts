import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_WINDOW_SOURCES_KEY, requestedContextWindowPreset } from "pi-libcontext/sdk";
import { registerRoleContextWindowSource } from "../src/contributions/context-window.ts";

describe("role context-window source", () => {
	let originalRegistry: object | undefined;

	beforeEach(() => {
		originalRegistry = Reflect.get(globalThis, CONTEXT_WINDOW_SOURCES_KEY) as object | undefined;
		Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
	});

	afterEach(() => {
		if (originalRegistry === undefined) Reflect.deleteProperty(globalThis, CONTEXT_WINDOW_SOURCES_KEY);
		else Reflect.set(globalThis, CONTEXT_WINDOW_SOURCES_KEY, originalRegistry);
	});

	test("resolves and disposes concurrent sessions independently", () => {
		const rootSession = {} as ExtensionContext["sessionManager"];
		const childSession = {} as ExtensionContext["sessionManager"];
		const rootContext = { sessionManager: rootSession } as ExtensionContext;
		const childContext = { sessionManager: childSession } as ExtensionContext;
		const removeRoot = registerRoleContextWindowSource(
			() => rootSession,
			() => "large",
		);
		const removeChild = registerRoleContextWindowSource(
			() => childSession,
			() => "max",
		);

		expect(requestedContextWindowPreset(rootContext)).toBe("large");
		expect(requestedContextWindowPreset(childContext)).toBe("max");

		removeChild();
		expect(requestedContextWindowPreset(rootContext)).toBe("large");
		expect(requestedContextWindowPreset(childContext)).toBeUndefined();
		removeRoot();
	});
});
