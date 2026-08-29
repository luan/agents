import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidePanelSession, SidePanelTab } from "pi-libtui";
import { ProcessHub, openProcessHub } from "./process-hub.ts";
import { ProcessHubCollection, type ProcessHubSource } from "./process-store.ts";

const TAB_ID = "pi-exec-command.process-hub";

/** Routes Process Hub presentation without making the side-panel host a runtime dependency. */
export class ProcessHubPresentation {
	private panel: SidePanelSession | undefined;
	private panelTabOpen = false;
	private removeEmptyAction: (() => void) | undefined;

	attach(panel: SidePanelSession): () => void {
		this.panel = panel;
		this.removeEmptyAction = panel.registerEmptyAction({
			id: "processes.open",
			label: "Processes",
			actionId: "processes.open",
		});
		return () => {
			if (this.panel !== panel) return;
			this.removeEmptyAction?.();
			this.removeEmptyAction = undefined;
			this.closeSidePanel();
			this.panel = undefined;
		};
	}

	async open(
		context: Pick<ExtensionContext, "hasUI" | "ui">,
		mode: "fullscreen" | "side-panel",
		sources: readonly ProcessHubSource[],
		initialProcessKey?: string,
	): Promise<void> {
		const panel = this.panel;
		if (mode !== "side-panel" || !panel) {
			await openProcessHub(context, sources, initialProcessKey);
			return;
		}
		const tab: SidePanelTab = {
			id: TAB_ID,
			label: "Processes",
			icon: "tools",
			create: (host, theme) =>
				new ProcessHub(
					new ProcessHubCollection(sources),
					host.tui,
					theme,
					() => this.closeSidePanel(),
					initialProcessKey,
				),
			onClose: () => {
				this.panelTabOpen = false;
			},
		};
		if (this.panelTabOpen) {
			panel.updateTab(tab);
			panel.activate(TAB_ID);
			panel.show({ focus: true });
		} else {
			this.panelTabOpen = true;
			panel.addTab(tab, { activate: true, focus: true });
		}
	}

	closeSidePanel(): void {
		if (!this.panelTabOpen) return;
		this.panelTabOpen = false;
		this.panel?.removeTab(TAB_ID);
	}
}
