import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ActionKeybindings } from "pi-libactions/sdk";
import { mountSplitPane, type SidePanelEmptyAction, type SidePanelSession, type SidePanelTab } from "pi-libtui";
import { EMPTY_SIDE_PANEL_STATE, type SidePanelLayoutState } from "./state.ts";
import { SidePanelView, type SidePanelViewModel } from "./view.ts";

export type PersistSidePanelLayout = (state: SidePanelLayoutState) => void;

export interface SidePanelRuntime {
	defer(callback: () => void): void;
	executeAction(id: string): void;
}

/** Owns one session's generic side-panel layout and contributed content. */
export class SidePanelController implements SidePanelSession, SidePanelViewModel {
	readonly protocol = "pi-side-panel/registry/v1" as const;
	readonly version = 1 as const;
	private state: SidePanelLayoutState;
	private readonly tabMap = new Map<string, SidePanelTab>();
	private readonly emptyActionMap = new Map<string, SidePanelEmptyAction>();
	private unmount: (() => void) | undefined;
	private panel: SidePanelView | undefined;
	private refreshScheduled = false;
	private zoomed = false;
	private disposed = false;

	constructor(
		initial: SidePanelLayoutState | undefined,
		private readonly persist: PersistSidePanelLayout,
		private readonly bindings: ActionKeybindings,
		private readonly runtime: SidePanelRuntime,
		private readonly scope: typeof globalThis,
	) {
		this.state = initial ?? EMPTY_SIDE_PANEL_STATE;
	}

	restore(): void {
		if (this.state.visible) this.mount(false);
	}

	addTab(tab: SidePanelTab, options: { activate?: boolean; focus?: boolean } = {}): void {
		if (this.disposed) return;
		this.tabMap.set(tab.id, tab);
		const order = this.state.order.includes(tab.id) ? this.state.order : [...this.state.order, tab.id];
		const activeTabId =
			options.activate !== false
				? tab.id
				: this.state.activeTabId && this.tabMap.has(this.state.activeTabId)
					? this.state.activeTabId
					: tab.id;
		this.setState({ ...this.state, visible: true, order, activeTabId });
		this.mount(options.focus !== false);
		this.panel?.refresh();
	}

	restoreTab(tab: SidePanelTab): void {
		if (this.disposed) return;
		this.tabMap.set(tab.id, tab);
		if (!this.state.order.includes(tab.id)) this.state = { ...this.state, order: [...this.state.order, tab.id] };
		this.scheduleRefresh();
	}

	updateTab(tab: SidePanelTab): void {
		if (!this.tabMap.has(tab.id)) return;
		this.tabMap.set(tab.id, tab);
		this.scheduleRefresh();
	}

	removeTab(id: string): void {
		if (!this.tabMap.delete(id)) return;
		const order = this.state.order.filter((candidate) => candidate !== id);
		const previousIndex = this.state.order.indexOf(id);
		const activeTabId =
			this.state.activeTabId === id
				? order[Math.min(Math.max(0, previousIndex), order.length - 1)]
				: this.state.activeTabId;
		const empty = this.tabMap.size === 0;
		this.setState({
			...this.state,
			visible: empty ? false : this.state.visible,
			order,
			...(activeTabId ? { activeTabId } : { activeTabId: undefined }),
		});
		if (empty) {
			this.zoomed = false;
			this.hide();
			return;
		}
		this.panel?.refresh();
	}

	activate(id: string): void {
		if (!this.tabMap.has(id) || this.state.activeTabId === id) return;
		this.setState({ ...this.state, activeTabId: id });
		this.panel?.refresh();
	}

	activeTabId(): string | undefined {
		return this.resolvedActiveTabId();
	}

	close(id: string): void {
		const tab = this.tabMap.get(id);
		if (!tab) return;
		tab.onClose?.();
		if (this.tabMap.has(id)) this.removeTab(id);
	}

	move(id: string, toIndex: number): void {
		const ordered = this.tabs().map((tab) => tab.id);
		const from = ordered.indexOf(id);
		if (from < 0) return;
		const target = Math.max(0, Math.min(Math.floor(toIndex), ordered.length - 1));
		if (from === target) return;
		ordered.splice(from, 1);
		ordered.splice(target, 0, id);
		this.setState({ ...this.state, order: ordered });
		this.panel?.refresh();
	}

	registerEmptyAction(action: SidePanelEmptyAction): () => void {
		this.emptyActionMap.set(action.id, action);
		this.panel?.refresh();
		return () => {
			if (this.emptyActionMap.get(action.id) !== action) return;
			this.emptyActionMap.delete(action.id);
			this.panel?.refresh();
		};
	}

	show(options: { focus?: boolean } = {}): void {
		if (this.disposed) return;
		this.setState({ ...this.state, visible: true });
		this.mount(options.focus === true && this.tabMap.size > 0);
	}

	toggle(): void {
		if (this.unmount) {
			this.zoomed = false;
			this.setState({ ...this.state, visible: false });
			this.hide();
			return;
		}
		this.show();
	}

	toggleZoom(): void {
		if (this.disposed) return;
		if (!this.unmount) {
			this.zoomed = true;
			this.show({ focus: this.tabMap.size > 0 });
			return;
		}
		const focused = this.panel?.isFocused() === true;
		this.zoomed = !this.zoomed;
		this.hide();
		this.mount(focused);
	}

	focus(): void {
		if (!this.unmount) this.show({ focus: true });
		else this.panel?.focus();
	}

	focusMain(): void {
		this.panel?.blur();
	}

	focusNext(): void {
		if (this.panel?.isFocused()) this.panel.blur();
		else this.focus();
	}

	activatePrevious(): void {
		this.activateOffset(-1);
	}

	activateNext(): void {
		this.activateOffset(1);
	}

	isVisible(): boolean {
		return this.unmount !== undefined;
	}

	isZoomed(): boolean {
		return this.zoomed;
	}

	tabs(): readonly SidePanelTab[] {
		return this.state.order.flatMap((id) => {
			const tab = this.tabMap.get(id);
			return tab ? [tab] : [];
		});
	}

	activeTab(): SidePanelTab | undefined {
		const id = this.resolvedActiveTabId();
		return id ? this.tabMap.get(id) : undefined;
	}

	emptyActions(): readonly SidePanelEmptyAction[] {
		return [...this.emptyActionMap.values()];
	}

	requestRender(): void {
		this.panel?.requestRender();
	}

	runAction(id: string): void {
		this.runtime.executeAction(id);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hide();
		this.tabMap.clear();
		this.emptyActionMap.clear();
	}

	private activateOffset(offset: -1 | 1): void {
		const tabs = this.tabs();
		if (tabs.length < 2) return;
		const current = Math.max(
			0,
			tabs.findIndex((tab) => tab.id === this.state.activeTabId),
		);
		const next = tabs[(current + offset + tabs.length) % tabs.length];
		if (next) this.activate(next.id);
	}

	private resolvedActiveTabId(): string | undefined {
		if (this.state.activeTabId && this.tabMap.has(this.state.activeTabId)) return this.state.activeTabId;
		return this.tabs()[0]?.id;
	}

	private mount(focus: boolean): void {
		if (this.disposed || this.unmount) {
			if (focus) this.panel?.focus();
			return;
		}
		this.unmount = mountSplitPane(
			{
				id: "pi-side-panel.host",
				position: "right",
				size: this.zoomed ? Number.MAX_SAFE_INTEGER : (this.state.width ?? 1),
				...(!this.zoomed && this.state.width === undefined ? { initialRatio: 0.5 } : {}),
				onResize: (width) => {
					this.setState({ ...this.state, width });
					if (!this.zoomed) return;
					this.zoomed = false;
					this.runtime.defer(() => {
						if (!this.unmount || this.disposed) return;
						const focused = this.panel?.isFocused() === true;
						this.hide();
						this.mount(focused);
					});
				},
				minMainSize: 1,
				gap: 0,
				priority: 200,
				component: (host, theme: Theme) => {
					const panel = new SidePanelView(this, host, theme, this.bindings);
					this.panel = panel;
					if (focus) panel.focus();
					return panel;
				},
			},
			this.scope,
		);
	}

	private hide(): void {
		this.panel?.blur();
		this.unmount?.();
		this.unmount = undefined;
		this.panel = undefined;
	}

	private scheduleRefresh(): void {
		if (this.refreshScheduled) return;
		this.refreshScheduled = true;
		this.runtime.defer(() => {
			this.refreshScheduled = false;
			if (!this.disposed) this.panel?.refresh();
		});
	}

	private setState(state: SidePanelLayoutState): void {
		this.state = state;
		this.persist(state);
		this.panel?.requestRender();
	}
}
