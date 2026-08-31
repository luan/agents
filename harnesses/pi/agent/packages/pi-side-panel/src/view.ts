import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, VStack, visibleWidth } from "@earendil-works/pi-tui";
import type { ActionKeybindings } from "pi-libactions/sdk";
import type { SidePanelContent, SidePanelEmptyAction, SidePanelTab } from "pi-libtui";
import { DialogButtonBar, type SplitPaneHost, screenIconActionsWidth, TabBar } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";

const PANEL_INPUT_ACTIONS = [
	"side-panel.toggle",
	"side-panel.zoom",
	"side-panel.focus.next",
	"side-panel.tab.previous",
	"side-panel.tab.next",
] as const;

export interface SidePanelViewModel {
	runAction(id: string): void;
	tabs(): readonly SidePanelTab[];
	activeTab(): SidePanelTab | undefined;
	emptyActions(): readonly SidePanelEmptyAction[];
	activate(id: string): void;
	close(id: string): void;
	move(id: string, toIndex: number): void;
	requestRender(): void;
}

class SidePanelHeader implements Component {
	private readonly action: DialogButtonBar<"header">;

	constructor(
		private readonly tabs: TabBar,
		theme: Theme,
		headerAction: SidePanelTab["headerAction"],
		bindings: ActionKeybindings,
		runAction: (id: string) => void,
		requestRender: () => void,
		private readonly reservedRight: number,
	) {
		this.action = new DialogButtonBar({
			theme,
			gap: 1,
			leading: (width) => this.tabs.render(width)[0] ?? "",
			buttons: headerAction
				? [
						{
							value: "header",
							label: `${headerAction.label} ▾`,
							foreground: "text.secondary",
							background: "surface.inset",
							shortcuts: bindings[headerAction.actionId],
							align: "end",
						},
					]
				: [],
			requestRender,
			onActivate: () => {
				if (headerAction) runAction(headerAction.actionId);
			},
		});
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.action.onMouse(event) || this.tabs.onMouse(event);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(0, width - this.reservedRight);
		const content = this.action.render(contentWidth)[0] ?? "";
		return [`${content}${" ".repeat(Math.max(0, width - visibleWidth(content)))}`];
	}

	invalidate(): void {
		this.action.invalidate();
		this.tabs.invalidate();
	}
}

class EmptySidePanel implements Component {
	private readonly buttons: readonly DialogButtonBar<string>[];
	private rows: readonly number[] = [];

	constructor(
		actions: readonly SidePanelEmptyAction[],
		theme: Theme,
		private readonly host: SplitPaneHost,
		bindings: ActionKeybindings,
		runAction: (id: string) => void,
	) {
		this.buttons = actions.map(
			(action) =>
				new DialogButtonBar({
					theme,
					buttons: [
						{
							value: action.id,
							label: action.label,
							foreground: "text.primary",
							background: "surface.inset",
							shortcuts: bindings[action.actionId],
							align: "center",
						},
					],
					requestRender: () => host.requestRender(),
					onActivate: () => runAction(action.actionId),
				}),
		);
	}

	handleInput(data: string): void {
		for (const button of this.buttons) if (button.handleInput(data)) return;
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.buttons.some((button, index) => button.onMouse({ ...event, row: event.row - (this.rows[index] ?? 0) }));
	}

	render(width: number): string[] {
		const height = Math.max(1, this.host.getTerminalSize().rows - 1);
		const stackHeight = Math.min(height, Math.max(0, this.buttons.length * 2 - 1));
		const start = Math.floor((height - stackHeight) / 2);
		this.rows = this.buttons.map((_button, index) => start + index * 2);
		const lines = Array.from({ length: height }, () => "");
		for (const [index, button] of this.buttons.entries()) {
			const row = this.rows[index];
			if (row !== undefined && row < height) lines[row] = button.render(width)[0] ?? "";
		}
		return lines;
	}

	invalidate(): void {
		for (const button of this.buttons) button.invalidate();
	}
}

/** Generic tabbed surface used by the side-panel host. */
export class SidePanelView extends VStack implements Focusable {
	readonly rendersWithinWidth = true;
	private header: SidePanelHeader | undefined;
	private body: SidePanelContent | undefined;
	private bodyTab: SidePanelTab | undefined;
	private providerInputActions: readonly string[] = [];
	private _focused = false;

	constructor(
		private readonly model: SidePanelViewModel,
		private readonly host: SplitPaneHost,
		private readonly theme: Theme,
		private readonly bindings: ActionKeybindings,
	) {
		super();
		this.refresh();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.body && "focused" in this.body) this.body.focused = value;
	}

	acceptsFocus(): boolean {
		return this.model.tabs().length > 0;
	}

	handleInput(data: string): void {
		const action = this.inputAction(data);
		if (action) {
			this.model.runAction(action);
			return;
		}
		this.body?.handleInput?.(data);
	}

	defersInputRender(data: string): boolean {
		return this.inputAction(data) === undefined && this.body?.defersInputRender?.(data) === true;
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.row === 0 && this.header) return this.header.onMouse(event);
		return this.body?.onMouse?.({ ...event, row: event.row - 1 }) === true;
	}

	focus(): void {
		if (!this.acceptsFocus()) return;
		this.host.focus();
		this.focused = this.host.isFocused();
		this.host.requestRender();
	}

	blur(): void {
		this.host.blur();
		this.focused = false;
		this.host.requestRender();
	}

	isFocused(): boolean {
		return this.host.isFocused();
	}

	refresh(): void {
		const wasFocused = this._focused;
		if (this.header) this.removeChild(this.header);
		if (this.body) this.removeChild(this.body);
		const tabs = this.model.tabs();
		const active = this.model.activeTab();
		const emptyActions = this.model.emptyActions();
		this.providerInputActions = emptyActions.map((action) => action.actionId);
		const activeIndex = Math.max(
			0,
			tabs.findIndex((tab) => tab.id === active?.id),
		);
		const tabBar = new TabBar(tabs, this.theme, activeIndex);
		tabBar.onChange = (tab) => this.model.activate(tab.id);
		tabBar.onClose = (tab) => this.model.close(tab.id);
		tabBar.onMove = (tab, _from, to) => this.model.move(tab.id, to);
		this.header = new SidePanelHeader(
			tabBar,
			this.theme,
			active?.headerAction,
			this.bindings,
			(id) => this.model.runAction(id),
			() => this.host.requestRender(),
			screenIconActionsWidth(2) + 1,
		);
		this.addChild(this.header, { basis: 1, grow: 0, shrink: 0, minSize: 1, maxSize: 1 });
		if (!this.body || !active || active !== this.bodyTab) {
			this.body?.dispose?.();
			this.body = active
				? active.create(this.host, this.theme)
				: new EmptySidePanel(emptyActions, this.theme, this.host, this.bindings, (id) => this.model.runAction(id));
			this.bodyTab = active;
		}
		const body = this.body;
		if (!body) return;
		this.addChild(body, {
			basis: Math.max(0, this.host.getTerminalSize().rows - 1),
			grow: 1,
			shrink: 1,
			minSize: 0,
		});
		if (tabs.length === 0 && wasFocused) this.blur();
		else this.focused = wasFocused;
		this.host.requestRender();
	}

	requestRender(): void {
		this.host.requestRender();
	}

	dispose(): void {
		this.focused = false;
		this.body?.dispose?.();
		this.body = undefined;
		this.bodyTab = undefined;
	}

	private inputAction(data: string): string | undefined {
		for (const id of PANEL_INPUT_ACTIONS) {
			if ((this.bindings[id] ?? []).some((key) => matchesKey(data, key))) return id;
		}
		for (const id of this.providerInputActions) {
			if ((this.bindings[id] ?? []).some((key) => matchesKey(data, key))) return id;
		}
		for (const id of this.model.activeTab()?.inputActions ?? []) {
			if ((this.bindings[id] ?? []).some((key) => matchesKey(data, key))) return id;
		}
		return undefined;
	}
}
