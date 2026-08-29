import { registerAction } from "pi-libactions/sdk";
import type { SidePanelSession } from "pi-libtui";

export function registerSidePanelActions(panel: SidePanelSession): () => void {
	const disposers = [
		registerAction({ id: "side-panel.toggle", description: "Show or hide the side panel", run: () => panel.toggle() }),
		registerAction({
			id: "side-panel.main.focus",
			description: "Focus the main session",
			run: () => panel.focusMain(),
		}),
		registerAction({ id: "side-panel.focus", description: "Focus the side panel", run: () => panel.focus() }),
		registerAction({
			id: "side-panel.focus.next",
			description: "Move focus to the other split pane",
			run: () => panel.focusNext(),
		}),
		registerAction({
			id: "side-panel.zoom",
			description: "Expand or restore the side panel",
			run: () => panel.toggleZoom(),
		}),
		registerAction({
			id: "side-panel.tab.previous",
			description: "Select the previous side-panel tab",
			run: () => panel.activatePrevious(),
		}),
		registerAction({
			id: "side-panel.tab.next",
			description: "Select the next side-panel tab",
			run: () => panel.activateNext(),
		}),
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
