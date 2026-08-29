import { expect, test } from "bun:test";
import type { SidePanelEmptyAction, SidePanelTab } from "pi-libtui";
import { ProcessHubPresentation } from "../src/ui/process-hub-presentation.ts";

test("Process Hub uses an attached side panel and otherwise falls back to fullscreen", async () => {
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
	const presentation = new ProcessHubPresentation();

	await presentation.open(context, "side-panel", []);
	expect(fullscreenOpens).toBe(1);

	const detach = presentation.attach(panel);
	expect(emptyAction).toEqual({ id: "processes.open", label: "Processes", actionId: "processes.open" });
	await presentation.open(context, "side-panel", []);
	expect(tab).toMatchObject({ id: "pi-exec-command.process-hub", label: "Processes" });
	expect(fullscreenOpens).toBe(1);

	detach();
	expect(emptyActionRemoved).toBe(true);
	await presentation.open(context, "side-panel", []);
	expect(fullscreenOpens).toBe(2);
});
