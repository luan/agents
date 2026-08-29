import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { SplitPaneHost } from "pi-libtui";
import {
	FullscreenOverlay,
	fullscreenOverlayOptions,
	PtyPane,
	PtyProcess,
	type SidePanelSession,
	type SidePanelTab,
} from "pi-libtui";
import {
	createSideChatCommand,
	prepareSideChatSession,
	resumeSideChatCommand,
	type SideChatRuntime,
} from "./session.ts";
import { SIDE_CHAT_STATE_ENTRY_TYPE, type SideChatState, type SideChatStateTab } from "./state.ts";

export class SideChatManager {
	private panel: SidePanelSession | undefined;
	private removeEmptyAction: (() => void) | undefined;
	private readonly overlayDone = new Map<string, () => void>();
	private readonly openOverlays = new Set<string>();
	private disposed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly context: ExtensionContext,
		private readonly runtime: SideChatRuntime,
		private state: SideChatState,
		private readonly createSessionId: () => string,
		private readonly scope: typeof globalThis,
		private readonly processes: Map<string, PtyProcess> = new Map(),
	) {
		const restoredIds = new Set(state.tabs.map((tab) => tab.id));
		for (const [id, process] of processes) {
			if (restoredIds.has(id)) continue;
			process.dispose();
			processes.delete(id);
		}
		for (const tab of state.tabs) {
			const process = this.processes.get(tab.id) ?? this.process(tab, resumeSideChatCommand(runtime, tab));
			process.setOnExit(() => this.close(tab.id));
			this.processes.set(tab.id, process);
		}
	}

	attachPanel(panel: SidePanelSession): () => void {
		this.panel = panel;
		this.removeEmptyAction = panel.registerEmptyAction({
			id: "side-chat.new",
			label: "Side chat",
			actionId: "side-panel.chat.new",
		});
		// Restored children start only when presented. Hidden children remain live,
		// while focus reporting lets cooperative TUIs pause their animation timers.
		for (const tab of this.state.tabs) {
			panel.restoreTab(this.panelTab(tab));
		}
		return () => {
			this.removeEmptyAction?.();
			this.removeEmptyAction = undefined;
			for (const tab of this.state.tabs) panel.removeTab(tab.id);
			if (this.panel === panel) this.panel = undefined;
		};
	}

	async restoreStandalone(): Promise<void> {
		if (this.disposed || this.panel) return;
		// A fullscreen host can present only one restored chat. The side panel owns simultaneous restored sessions.
		const tab = this.state.tabs.at(-1);
		const process = tab ? this.processes.get(tab.id) : undefined;
		if (tab && process) await this.openOverlay(tab, process);
	}

	async newChat(prompt?: string): Promise<void> {
		if (this.disposed) return;
		const sessionId = this.createSessionId();
		const tab: SideChatStateTab = {
			id: `side-chat:${sessionId}`,
			label: `Side ${this.state.nextNumber}`,
			sessionId,
		};
		this.state = {
			version: 1,
			nextNumber: this.state.nextNumber + 1,
			tabs: [...this.state.tabs, tab],
		};
		this.persist();
		const command = createSideChatCommand(prepareSideChatSession(this.runtime, tab, prompt?.trim() || undefined));
		const process = this.process(tab, command);
		this.processes.set(tab.id, process);
		if (this.panel) {
			this.panel.addTab(this.panelTab(tab), { activate: true, focus: true });
			return;
		}
		await this.openOverlay(tab, process);
	}

	closeActive(): void {
		const active = this.panel ? this.state.tabs.find((tab) => tab.id === this.panelActiveId()) : undefined;
		if (active) this.close(active.id);
	}

	dispose(options: { readonly preserveProcesses?: boolean } = {}): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeEmptyAction?.();
		for (const done of this.overlayDone.values()) done();
		this.overlayDone.clear();
		for (const process of this.processes.values()) {
			process.setOnExit(undefined);
			if (!options.preserveProcesses) process.dispose();
		}
		if (!options.preserveProcesses) this.processes.clear();
		this.panel = undefined;
	}

	private panelActiveId(): string | undefined {
		return this.panel?.activeTabId();
	}

	private process(tab: SideChatStateTab, command: string): PtyProcess {
		return new PtyProcess({
			label: tab.label,
			command,
			context: this.context,
			onExit: () => this.close(tab.id),
			scope: this.scope,
		});
	}

	private panelTab(tab: SideChatStateTab): SidePanelTab {
		return {
			id: tab.id,
			label: tab.label,
			icon: { glyph: "󱐒" },
			inputActions: ["side-panel.chat.new"],
			create: (host: SplitPaneHost, _theme: Theme) =>
				new PtyPane(this.processes.get(tab.id)!, {
					tui: host.tui,
					rows: () => Math.max(1, host.getTerminalSize().rows - 1),
					requestRender: () => host.requestRender(),
				}),
			onClose: () => this.close(tab.id),
		};
	}

	private close(id: string): void {
		const process = this.processes.get(id);
		if (!process && !this.state.tabs.some((tab) => tab.id === id)) return;
		process?.dispose();
		this.processes.delete(id);
		this.state = {
			...this.state,
			tabs: this.state.tabs.filter((tab) => tab.id !== id),
		};
		this.persist();
		this.panel?.removeTab(id);
		this.overlayDone.get(id)?.();
		this.overlayDone.delete(id);
	}

	private async openOverlay(tab: SideChatStateTab, process: PtyProcess): Promise<void> {
		if (!this.context.hasUI || !this.context.ui.custom || this.openOverlays.has(tab.id)) return;
		this.openOverlays.add(tab.id);
		try {
			await this.context.ui.custom<void>(
				(tui, theme, _keys, done) => {
					this.overlayDone.set(tab.id, () => done(undefined));
					const pane = new PtyPane(process, {
						tui,
						rows: () => Math.max(1, tui.terminal.rows - 2),
						requestRender: () => tui.requestRender(),
					});
					return new FullscreenOverlay(tui, theme, pane, {
						label: tab.label,
						icon: "developer",
					});
				},
				{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
			);
		} finally {
			this.openOverlays.delete(tab.id);
			this.overlayDone.delete(tab.id);
		}
	}

	private persist(): void {
		this.pi.appendEntry(SIDE_CHAT_STATE_ENTRY_TYPE, this.state);
	}
}
