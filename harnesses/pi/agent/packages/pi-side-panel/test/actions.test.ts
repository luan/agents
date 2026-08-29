import { expect, test } from "bun:test";
import { ensureActionsRegistry } from "pi-libactions/sdk";
import type { SidePanelSession } from "pi-libtui";
import { registerSidePanelActions } from "../src/actions.ts";

test("registers panel actions that invoke the panel", async () => {
	const calls: string[] = [];
	const panel = {
		toggle: () => calls.push("toggle"),
		focusMain: () => calls.push("main"),
		focus: () => calls.push("focus"),
		focusNext: () => calls.push("next"),
		toggleZoom: () => calls.push("zoom"),
		activatePrevious: () => calls.push("previous"),
		activateNext: () => calls.push("next-tab"),
	} as never as SidePanelSession;
	const dispose = registerSidePanelActions(panel);
	const registry = ensureActionsRegistry();
	for (const id of [
		"side-panel.toggle",
		"side-panel.main.focus",
		"side-panel.focus",
		"side-panel.focus.next",
		"side-panel.zoom",
		"side-panel.tab.previous",
		"side-panel.tab.next",
	])
		await registry.find(id)?.run({} as never);
	expect(calls).toEqual(["toggle", "main", "focus", "next", "zoom", "previous", "next-tab"]);
	dispose();
});
