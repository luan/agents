import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type OverlayHandle, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ModelRole,
	type ModelRoleCatalog,
	moveModelRole,
	roleColor,
	roleNames,
	saveModelRoles,
} from "./catalog.js";
import { addModelRole, deleteModelRole, editModelRole, setModelRoleDefault } from "./editor.js";

type PickerTheme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

type PickerTui = Pick<TUI, "requestRender" | "terminal">;

const BORDER = "accent";
const SELECTED_BACKGROUND = "selectedBg";

function selectedIndex(names: string[], selected: string | undefined): number {
	const index = selected ? names.indexOf(selected) : -1;
	return index >= 0 ? index : 0;
}

function fastEnabled(role: ModelRole): boolean {
	return role.candidates.some((candidate) => candidate.service_tier === "priority");
}

export async function openModelRolePicker(
	ctx: ExtensionContext,
	catalog: ModelRoleCatalog,
	initialRole?: string,
): Promise<string | undefined> {
	if (!ctx.hasUI || !ctx.ui.custom) return undefined;
	let picker: ModelRolePicker | undefined;
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			picker = new ModelRolePicker(ctx, tui, theme, done, catalog, initialRole);
			return picker;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", anchor: "bottom-left" },
			onHandle: (handle) => picker?.setOverlayHandle(handle),
		},
	);
}

class ModelRolePicker {
	private selected = 0;
	private names: string[] = [];
	private deletePending = false;
	private deleteTimer?: ReturnType<typeof setTimeout>;
	private busy = false;
	private overlayHandle?: OverlayHandle;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly tui: PickerTui,
		private readonly theme: PickerTheme,
		private readonly done: (role: string | undefined) => void,
		private readonly catalog: ModelRoleCatalog,
		initialRole?: string,
	) {
		this.names = roleNames(catalog);
		this.selected = selectedIndex(this.names, initialRole);
		this.sync();
	}
	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (this.deletePending && data !== "d") this.clearDeletePending();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "d") {
			if (this.deletePending) {
				this.clearDeletePending();
				void this.deleteSelected();
			} else {
				this.deletePending = true;
				this.deleteTimer = setTimeout(() => this.clearDeletePending(), 700);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("j"))) {
			this.reorder(1);
			return;
		}
		if (matchesKey(data, Key.ctrl("k"))) {
			this.reorder(-1);
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (data === "k" || matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.select(0);
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.select(this.names.length - 1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			this.chooseSelected();
			return;
		}
		if (data === "e") {
			void this.editSelected();
			return;
		}
		if (data === "a") {
			void this.addRole();
			return;
		}
		if (data === "f") this.setDefault();
	}

	render(width: number): string[] {
		this.sync();
		const terminalHeight = this.tui.terminal.rows;
		if (width < 32 || terminalHeight < 8) return [];
		const innerWidth = Math.max(28, width - 2);
		const bodyHeight = Math.max(1, Math.min(8, terminalHeight - 5));
		const start = Math.max(0, Math.min(this.selected - bodyHeight + 1, this.names.length - bodyHeight));
		const position = this.names.length > 0 ? this.theme.fg("dim", ` ${this.selected + 1}/${this.names.length}`) : "";
		const lines = [
			this.frame(`${this.theme.fg("accent", this.theme.bold("Select model role"))}${position}`, innerWidth),
			this.frame("", innerWidth),
		];
		for (const [offset, name] of this.names.slice(start, start + bodyHeight).entries()) {
			const index = start + offset;
			lines.push(
				this.frame(
					this.renderRole(name, this.catalog.roles[name]!, index === this.selected, innerWidth),
					innerWidth,
				),
			);
		}
		if (this.busy) lines.push(this.frame(this.theme.fg("dim", "Working..."), innerWidth));
		else if (this.deletePending)
			lines.push(this.frame(this.theme.fg("warning", "Press d again to delete."), innerWidth));
		else lines.push(this.frame("", innerWidth));
		lines.push(this.frame(this.theme.fg("dim", this.hints(innerWidth)), innerWidth));
		lines.push(this.bottom(innerWidth));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.clearDeletePending();
		this.busy = true;
	}

	private sync(): void {
		const selectedName = this.names[this.selected];
		this.names = roleNames(this.catalog);
		this.selected = selectedIndex(this.names, selectedName);
	}

	private move(delta: number): void {
		if (this.names.length === 0) return;
		this.selected = Math.max(0, Math.min(this.names.length - 1, this.selected + delta));
		this.tui.requestRender();
	}
	private reorder(delta: number): void {
		const name = this.selectedName();
		if (!name || !moveModelRole(this.catalog, name, delta)) return;
		saveModelRoles(this.catalog);
		this.sync();
		this.tui.requestRender();
	}

	private select(index: number): void {
		if (this.names.length === 0) return;
		this.selected = Math.max(0, Math.min(this.names.length - 1, index));
		this.tui.requestRender();
	}

	private selectedName(): string | undefined {
		return this.names[this.selected];
	}

	private chooseSelected(): void {
		const name = this.selectedName();
		if (name) this.done(name);
	}

	private async editSelected(): Promise<void> {
		const name = this.selectedName();
		if (!name) return;
		await this.run(async () => editModelRole(this.ctx, this.catalog, name));
	}

	private async addRole(): Promise<void> {
		await this.run(async () => {
			const name = await addModelRole(this.ctx, this.catalog);
			if (name) this.selected = roleNames(this.catalog).indexOf(name);
		});
	}

	private setDefault(): void {
		const name = this.selectedName();
		if (!name || !setModelRoleDefault(this.catalog, name)) return;
		this.ctx.ui.notify(`Default role: ${name}`, "info");
		this.tui.requestRender();
	}

	private async deleteSelected(): Promise<void> {
		const name = this.selectedName();
		if (!name) return;
		await this.run(async () => {
			await deleteModelRole(this.ctx, this.catalog, name);
			this.sync();
		});
	}

	private async run(action: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.overlayHandle?.setHidden(true);
		this.tui.requestRender();
		try {
			await action();
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.busy = false;
			this.sync();
			this.overlayHandle?.setHidden(false);
			this.tui.requestRender();
		}
	}

	private clearDeletePending(): void {
		if (this.deleteTimer) clearTimeout(this.deleteTimer);
		this.deleteTimer = undefined;
		this.deletePending = false;
	}

	private renderRole(name: string, role: ModelRole, selected: boolean, width: number): string {
		const candidate = role.candidates[0];
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		const defaultMarker = name === this.catalog.defaultRole ? this.theme.fg("warning", "default") : "       ";
		const roleText = this.theme.fg(roleColor(role, this.names.indexOf(name)), this.theme.bold(name));
		const model = candidate ? this.theme.fg("muted", candidate.model) : this.theme.fg("warning", "no model");
		const thinking = candidate ? this.theme.fg("dim", candidate.thinking) : "";
		const fast = fastEnabled(role) ? this.theme.fg("success", "fast") : "";
		const fallback =
			role.candidates.length > 1 ? this.theme.fg("dim", `+${role.candidates.length - 1} fallback`) : "";
		const raw = ` ${cursor} ${defaultMarker} ${roleText} ${model} ${thinking} ${fast} ${fallback}`;
		const clipped = truncateToWidth(raw, width);
		const rendered = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return selected ? this.theme.bg(SELECTED_BACKGROUND, rendered) : rendered;
	}

	private hints(width: number): string {
		return truncateToWidth(
			"↑↓/jk navigate  ctrl+j/k reorder  enter select  e edit  a add  dd delete  f default  esc/q cancel",
			width,
		);
	}

	private frame(content: string, width: number): string {
		const clipped = truncateToWidth(content, width);
		return `${this.theme.fg(BORDER, "│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${this.theme.fg(BORDER, "│")}`;
	}

	private bottom(width: number): string {
		return this.theme.fg(BORDER, `└${"─".repeat(Math.max(0, width))}┘`);
	}
}
