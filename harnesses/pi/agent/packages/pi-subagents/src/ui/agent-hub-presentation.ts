import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidePanelSession, SidePanelTab } from "pi-libtui";
import type { AgentPresentationResolverLookup } from "../protocol/presentation.ts";
import { AgentHub, type AgentHubSnapshotSource, openAgentHub } from "./agent-browser.ts";

const TAB_ID = "pi-subagents.agent-hub";

/** Routes Agent Hub presentation without making the side-panel host a runtime dependency. */
export class AgentHubPresentation {
	private panel: SidePanelSession | undefined;
	private panelTabOpen = false;
	private removeEmptyAction: (() => void) | undefined;

	constructor(
		private readonly source: AgentHubSnapshotSource,
		private readonly now: () => number,
		private readonly resolvePresentation: AgentPresentationResolverLookup,
	) {}

	attach(panel: SidePanelSession): () => void {
		this.panel = panel;
		this.removeEmptyAction = panel.registerEmptyAction({
			id: "subagents.open",
			label: "Agents",
			actionId: "subagents.open",
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
		initialAgentId?: string,
	): Promise<void> {
		const panel = this.panel;
		if (mode !== "side-panel" || !panel) {
			await openAgentHub(context, this.source, this.now, this.resolvePresentation, initialAgentId);
			return;
		}
		const tab: SidePanelTab = {
			id: TAB_ID,
			label: "Agents",
			icon: "developer" as const,
			create: (host, theme) =>
				new AgentHub(
					this.source,
					host.tui,
					theme,
					() => this.closeSidePanel(),
					this.now,
					this.resolvePresentation,
					initialAgentId,
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
