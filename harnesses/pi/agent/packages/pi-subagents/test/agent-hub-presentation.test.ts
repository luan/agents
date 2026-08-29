import { expect, test } from "bun:test";
import type { SidePanelEmptyAction, SidePanelTab } from "pi-libtui";
import { AgentHubPresentation } from "../src/ui/agent-hub-presentation.ts";

const source = {
	getSnapshot: () => ({ generation: 0, agents: [] }),
	subscribe: () => () => {},
};

test("Agent Hub uses an attached side panel and otherwise falls back to fullscreen", async () => {
	let tab: SidePanelTab | undefined;
	let emptyAction: SidePanelEmptyAction | undefined;
	let emptyActionRemoved = false;
	let fullscreenOpens = 0;
	const panel = {
		registerEmptyAction(next: SidePanelEmptyAction) {
			emptyAction = next;
			return () => {
				emptyActionRemoved = true;
			};
		},
		addTab(next: SidePanelTab) {
			tab = next;
		},
		updateTab() {},
		removeTab() {},
		activate() {},
		show() {},
	} as never;
	const context = {
		hasUI: true,
		ui: {
			async custom() {
				fullscreenOpens++;
			},
		},
	} as never;
	const presentation = new AgentHubPresentation(
		source,
		() => 0,
		() => undefined,
	);

	await presentation.open(context, "side-panel");
	expect(fullscreenOpens).toBe(1);

	const detach = presentation.attach(panel);
	expect(emptyAction).toEqual({ id: "subagents.open", label: "Agents", actionId: "subagents.open" });
	await presentation.open(context, "side-panel", "/root/review");
	expect(tab).toMatchObject({ id: "pi-subagents.agent-hub", label: "Agents" });
	expect(fullscreenOpens).toBe(1);

	detach();
	expect(emptyActionRemoved).toBe(true);
	await presentation.open(context, "side-panel");
	expect(fullscreenOpens).toBe(2);
});
