import { afterEach, describe, expect, test } from "bun:test";
import {
	NESTED_TOOL_ADAPTERS,
	NESTED_TOOL_ADAPTER_PROTOCOL,
	getNestedToolAdapterRegistry,
	listNestedToolAdapters,
	registerNestedToolAdapter,
} from "../../src/protocol/nested-tools.ts";
import type { NestedToolAdapter } from "../../src/protocol/types.ts";

function adapter(name: string): NestedToolAdapter {
	return {
		name,
		kind: "function",
		parameters: { type: "object" },
		invoke: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
	};
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, NESTED_TOOL_ADAPTERS);
});

describe("nested tool adapter registry", () => {
	test("uses the versioned global symbol contract", () => {
		const registry = getNestedToolAdapterRegistry();

		expect(Symbol.keyFor(NESTED_TOOL_ADAPTERS)).toBe(NESTED_TOOL_ADAPTER_PROTOCOL);
		expect(registry.protocol).toBe(NESTED_TOOL_ADAPTER_PROTOCOL);
		expect(registry.version).toBe(2);
		expect((globalThis as Record<PropertyKey, unknown>)[NESTED_TOOL_ADAPTERS]).toBe(registry);
	});

	test("claims concurrent same-name adapters for their loading sessions", () => {
		const rootTool = {};
		const childTool = {};
		const rootScope = {};
		const childScope = {};
		const first = { ...adapter("exec_command"), owner: rootTool };
		const disposeFirst = registerNestedToolAdapter(first);
		getNestedToolAdapterRegistry().claim(rootScope);
		const second = { ...adapter("exec_command"), owner: childTool };
		const disposeSecond = registerNestedToolAdapter(second);
		getNestedToolAdapterRegistry().claim(childScope);

		expect(listNestedToolAdapters(rootScope)).toEqual([first]);
		expect(listNestedToolAdapters(childScope)).toEqual([second]);
		disposeFirst();
		expect(getNestedToolAdapterRegistry().adapters.get("exec_command")).toBe(second);
		expect(listNestedToolAdapters(childScope)).toEqual([second]);

		disposeSecond();
		expect(getNestedToolAdapterRegistry().adapters.get("exec_command")).toBeUndefined();
	});
});
