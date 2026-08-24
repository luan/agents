import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureActionsRegistry } from "pi-libactions/sdk";
import { registerCopyModeAction } from "../src/contributions/actions.ts";

test("entry action uses the shared registry and unregisters by identity", () => {
	let runs = 0;
	const unregister = registerCopyModeAction(() => {
		runs += 1;
	});
	const registry = ensureActionsRegistry();
	expect(registry.protocol).toBe("pi-libactions/registry/v1");
	expect(registry.find("copy-mode.enter")?.description).toBe("Enter transcript copy mode");
	const seen: string[] = [];
	registry.onRegister((action) => seen.push(action.id));
	registry.register({ id: "later", description: "later", run() {} });
	expect(seen).toEqual(["later"]);
	void registry.find("copy-mode.enter")?.run({} as ExtensionContext);
	expect(runs).toBe(1);
	unregister();
	expect(registry.find("copy-mode.enter")).toBeUndefined();
});
