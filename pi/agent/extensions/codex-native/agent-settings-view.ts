import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { truncateToWidthCompat } from "../shared/tui";

/**
 * One changeable setting. `onStep` is required: a row that cannot change is status, and status
 * belongs in `/agent-settings` output, not in this panel.
 */
export interface AgentSettingsRow {
	id: string;
	label: string;
	description: string;
	value: () => string;
	/** Step the value. `delta` is -1 or 1. A two-state row flips on either sign. */
	onStep: (delta: number) => void | Promise<void>;
}

export interface AgentSettingsTab {
	id: string;
	label: string;
	hint: string;
	rows: () => readonly AgentSettingsRow[];
}

const MAX_VISIBLE_ROWS = 14;
const DESCRIPTION_LINES = 3;
const JUMP_KEYS = "123456789";

export class AgentSettingsPanel implements Component {
	private selectedIndex = 0;
	private tabIndex = 0;
	private filter = "";
	private busyRowId: string | undefined;
	private pendingAction = Promise.resolve();

	constructor(
		private readonly theme: Theme,
		private readonly tabs: readonly AgentSettingsTab[],
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly onError: (error: unknown, rowId: string) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up)) this.moveSelection(-1);
		else if (matchesKey(data, Key.down)) this.moveSelection(1);
		else if (matchesKey(data, Key.shift(Key.tab))) this.moveTab(-1);
		else if (matchesKey(data, Key.tab)) this.moveTab(1);
		else if (matchesKey(data, Key.left)) this.stepSelected(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter) || data === "\r") this.stepSelected(1);
		else if (matchesKey(data, Key.backspace) || data === "\x7f") this.setFilter(this.filter.slice(0, -1));
		else if (JUMP_KEYS.includes(data)) this.jumpTo(JUMP_KEYS.indexOf(data));
		else if (data.length === 1 && data >= " ") this.setFilter(this.filter + data);
		this.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const { rows, index } = this.view();
		const selected = rows[index];
		const lines = [
			this.titleBorder(innerWidth),
			this.row(this.tabBar(), innerWidth),
			this.row(this.theme.fg("dim", this.currentTab()?.hint ?? ""), innerWidth),
			this.divider(innerWidth),
		];

		const start = Math.max(0, Math.min(index - Math.floor(MAX_VISIBLE_ROWS / 2), rows.length - MAX_VISIBLE_ROWS));
		const visible = rows.slice(start, start + MAX_VISIBLE_ROWS);
		if (visible.length === 0) lines.push(this.row(this.theme.fg("muted", "No matching settings"), innerWidth));
		for (const [offset, setting] of visible.entries()) {
			lines.push(this.row(this.renderSetting(setting, start + offset, start + offset === index), innerWidth));
		}
		if (rows.length > visible.length) {
			lines.push(this.row(this.theme.fg("dim", `${index + 1}/${rows.length}`), innerWidth));
		}

		lines.push(this.divider(innerWidth));
		// Pad to a fixed height so the box does not jump as the cursor moves between rows.
		const description = wrapTextWithAnsi(selected?.description ?? "", Math.max(12, innerWidth - 2));
		for (let line = 0; line < DESCRIPTION_LINES; line++) {
			lines.push(this.row(description[line] ? this.theme.fg("dim", description[line]!) : "", innerWidth));
		}
		lines.push(this.divider(innerWidth));
		lines.push(this.centerRow(this.theme.fg("dim", this.hints()), innerWidth));
		lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	async waitForPendingActions(): Promise<void> {
		await this.pendingAction;
	}

	private hints(): string {
		const filter = this.filter ? `filter: ${this.filter}▌  ` : "";
		return `${filter}type to filter  1-9 jump  ←/→ change  tab switch  esc close`;
	}

	private currentTab(): AgentSettingsTab | undefined {
		return this.tabs[this.tabIndex];
	}

	/** The rows on screen, and the cursor clamped to them. Neither depends on render order. */
	private view(): { rows: readonly AgentSettingsRow[]; index: number } {
		const all = this.currentTab()?.rows() ?? [];
		const query = this.filter.toLowerCase();
		const rows = query ? all.filter((row) => `${row.label} ${row.description}`.toLowerCase().includes(query)) : all;
		return { rows, index: Math.max(0, Math.min(this.selectedIndex, rows.length - 1)) };
	}

	private setFilter(filter: string): void {
		this.filter = filter;
		this.selectedIndex = 0;
	}

	private jumpTo(index: number): void {
		if (index < this.view().rows.length) this.selectedIndex = index;
	}

	private moveTab(delta: number): void {
		if (this.tabs.length === 0) return;
		this.tabIndex = (this.tabIndex + delta + this.tabs.length) % this.tabs.length;
		this.selectedIndex = 0;
		this.filter = "";
	}

	private moveSelection(delta: number): void {
		const { rows, index } = this.view();
		if (rows.length === 0) return;
		this.selectedIndex = (index + delta + rows.length) % rows.length;
	}

	private stepSelected(delta: number): void {
		const { rows, index } = this.view();
		const setting = rows[index];
		// A second press while the first write is in flight would queue a duplicate write.
		if (!setting || this.busyRowId) return;
		this.busyRowId = setting.id;
		this.pendingAction = this.pendingAction
			.then(() => setting.onStep(delta))
			.catch((error) => this.onError(error, setting.id))
			.then(() => {
				this.busyRowId = undefined;
				this.requestRender();
			});
	}

	private tabBar(): string {
		return this.tabs
			.map((tab, index) =>
				index === this.tabIndex
					? this.theme.fg("accent", this.theme.bold(tab.label))
					: this.theme.fg("dim", tab.label),
			)
			.join(this.theme.fg("dim", "  ·  "));
	}

	private renderSetting(setting: AgentSettingsRow, index: number, selected: boolean): string {
		const jump = JUMP_KEYS[index] ?? " ";
		const marker = selected ? this.theme.fg("accent", "▸") : " ";
		const label = selected ? this.theme.fg("text", this.theme.bold(setting.label)) : setting.label;
		const value = this.busyRowId === setting.id ? "…" : `[${setting.value()}]`;
		return `${this.theme.fg("dim", jump)} ${marker} ${label}  ${this.theme.fg("accent", value)}`;
	}

	private titleBorder(width: number): string {
		const title = " Agent Settings ";
		const remaining = Math.max(0, width - visibleWidth(title));
		const left = Math.floor(remaining / 2);
		return this.theme.fg("borderMuted", `╭${"─".repeat(left)}${title}${"─".repeat(remaining - left)}╮`);
	}

	private divider(width: number): string {
		return this.theme.fg("borderMuted", `├${"─".repeat(width)}┤`);
	}

	private row(content: string, width: number): string {
		const fitted = truncateToWidthCompat(` ${content}`, width, "…", true);
		const border = this.theme.fg("borderMuted", "│");
		return `${border}${fitted}${border}`;
	}

	private centerRow(content: string, width: number): string {
		const padding = Math.max(0, width - visibleWidth(content));
		return this.row(`${" ".repeat(Math.max(0, Math.floor(padding / 2) - 1))}${content}`, width);
	}
}
