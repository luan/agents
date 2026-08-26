import { afterEach, expect, test } from "bun:test";
import {
	SESSION_HIERARCHY,
	SESSION_HIERARCHY_PROTOCOL,
	registerSessionHierarchyProvider,
} from "../src/protocol/session-hierarchy.ts";

interface TestHierarchyCapability {
	readonly protocol: typeof SESSION_HIERARCHY_PROTOCOL;
	readonly version: 1;
	descendants(sessionId: string): readonly { readonly sessionId: string; readonly path: string }[] | undefined;
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, SESSION_HIERARCHY);
});

test("session hierarchy isolates provider failures and returns frozen copies", () => {
	registerSessionHierarchyProvider(() => {
		throw new Error("stale provider");
	});
	const entries = [{ sessionId: "root", path: "/root" }];
	registerSessionHierarchyProvider(() => entries);
	const capability = Reflect.get(globalThis, SESSION_HIERARCHY) as TestHierarchyCapability;

	const result = capability.descendants("root");
	expect(capability.protocol).toBe(SESSION_HIERARCHY_PROTOCOL);
	expect(result).toEqual(entries);
	expect(Object.isFrozen(result)).toBe(true);
	expect(Object.isFrozen(result?.[0])).toBe(true);
	expect(result).not.toBe(entries);
});

test("session hierarchy disposal removes only its provider", () => {
	const disposeFirst = registerSessionHierarchyProvider(() => [{ sessionId: "first", path: "/root" }]);
	registerSessionHierarchyProvider(() => [{ sessionId: "second", path: "/root" }]);
	const capability = Reflect.get(globalThis, SESSION_HIERARCHY) as TestHierarchyCapability;

	expect(capability.descendants("root")?.[0]?.sessionId).toBe("first");
	disposeFirst();
	expect(capability.descendants("root")?.[0]?.sessionId).toBe("second");
});
