import { afterEach, describe, expect, test } from "bun:test";
import {
	NESTED_TOOL_PREFLIGHTS,
	getNestedToolPreflightRegistry,
	registerNestedToolPreflight,
	runNestedToolPreflights,
} from "../../src/protocol/preflights.ts";
import type { NestedToolPreflightCall } from "../../src/protocol/types.ts";

function call(signal = new AbortController().signal): NestedToolPreflightCall {
	return {
		toolName: "exec_command",
		input: { command: { argv: ["git", "status"] } },
		cwd: "/workspace",
		toolCallId: "cell:tool",
		extensionContext: {} as NestedToolPreflightCall["extensionContext"],
		signal,
	};
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, NESTED_TOOL_PREFLIGHTS);
});

describe("nested tool preflight registry", () => {
	test("runs all guards in registration order with a frozen input snapshot", async () => {
		const events: string[] = [];
		registerNestedToolPreflight((request) => {
			events.push("first");
			expect(Object.isFrozen(request.input)).toBe(true);
			expect(Object.isFrozen((request.input as { command: object }).command)).toBe(true);
		});
		registerNestedToolPreflight(async () => {
			events.push("second");
		});

		await runNestedToolPreflights(call());

		expect(events).toEqual(["first", "second"]);
	});

	test("fails closed for blocks and guard errors", async () => {
		registerNestedToolPreflight(() => ({ block: true, reason: "policy denied" }));
		await expect(runNestedToolPreflights(call())).rejects.toThrow("policy denied");

		Reflect.deleteProperty(globalThis, NESTED_TOOL_PREFLIGHTS);
		registerNestedToolPreflight(() => {
			throw new Error("guard failed");
		});
		await expect(runNestedToolPreflights(call())).rejects.toThrow("guard failed");
	});

	test("stops waiting when the signal aborts", async () => {
		const controller = new AbortController();
		registerNestedToolPreflight(() => new Promise(() => undefined));
		const pending = runNestedToolPreflights(call(controller.signal));
		controller.abort(new Error("cancelled"));

		await expect(pending).rejects.toThrow("cancelled");
	});

	test("each disposer removes only its registered guard", () => {
		const guard = () => undefined;
		const disposeFirst = registerNestedToolPreflight(guard);
		const disposeSecond = registerNestedToolPreflight(guard);

		disposeSecond();
		expect(getNestedToolPreflightRegistry().guards).toEqual([guard]);
		disposeFirst();
		expect(getNestedToolPreflightRegistry().guards).toEqual([]);
	});
});
