import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type OverlayHandle, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	defaultRoleColor,
	formatModelRoleOption,
	type ModelRole,
	type ModelRoleCatalog,
	nextRoleColor,
	ROLE_COLORS,
	type RoleCandidate,
	roleColor,
	roleNames,
	saveModelRoles,
} from "./catalog.js";
import { openChoicePicker } from "./choice-picker.js";
import { openModelCandidatePicker } from "./model-picker.js";

const DONE = "Done";

function validRoleName(name: string): boolean {
	return /^[A-Za-z][A-Za-z0-9._-]*$/.test(name);
}

async function editCandidate(ctx: ExtensionContext, current?: RoleCandidate): Promise<RoleCandidate | undefined> {
	return openModelCandidatePicker(ctx, current);
}
const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_COLORS: Record<ThinkingLevel, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

type EditorTheme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

type EditorTui = Pick<TUI, "requestRender" | "terminal">;

function thinkingLevels(ctx: ExtensionContext, candidate: RoleCandidate): ThinkingLevel[] {
	const slash = candidate.model.indexOf("/");
	if (slash <= 0) return ALL_THINKING_LEVELS;
	const model = ctx.modelRegistry.find(candidate.model.slice(0, slash), candidate.model.slice(slash + 1));
	return model ? getSupportedThinkingLevels(model) : ALL_THINKING_LEVELS;
}

function modeOptions(candidate: RoleCandidate): string[] {
	const current = candidate.service_tier;
	const options = ["off", "priority (fast)"];
	if (current && current !== "off" && current !== "priority") options.unshift(current);
	return options;
}

async function openRoleEditor(ctx: ExtensionContext, catalog: ModelRoleCatalog, name: string): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	let editor: RoleEditor | undefined;
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) => {
			editor = new RoleEditor(ctx, tui, theme, done, catalog, name);
			return editor;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", anchor: "bottom-left" },
			onHandle: (handle) => editor?.setOverlayHandle(handle),
		},
	);
}

class RoleEditor {
	private selected = 0;
	private busy = false;
	private overlayHandle?: OverlayHandle;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly tui: EditorTui,
		private readonly theme: EditorTheme,
		private readonly done: (value: undefined) => void,
		private readonly catalog: ModelRoleCatalog,
		private readonly name: string,
	) {
		const role = this.role();
		role.color ??= defaultRoleColor(Math.max(0, roleNames(catalog).indexOf(name)));
	}

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
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
			this.select(this.role().candidates.length - 1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n" || data === "e") {
			void this.editSelected();
			return;
		}
		if (data === "t") {
			void this.changeThinking();
			return;
		}
		if (data === "m") {
			void this.changeMode();
			return;
		}
		if (data === "c") {
			void this.changeColor();
			return;
		}
		if (data === "a") {
			void this.addCandidate();
			return;
		}
		if (data === "x") void this.removeSelected();
	}

	render(width: number): string[] {
		const role = this.role();
		const color = roleColor(role, Math.max(0, roleNames(this.catalog).indexOf(this.name)));
		const terminalHeight = this.tui.terminal.rows;
		if (width < 40 || terminalHeight < 10) return [];
		const innerWidth = Math.max(36, width - 2);
		const candidates = role.candidates;
		const bodyHeight = Math.max(1, Math.min(8, terminalHeight - 7));
		const start = Math.max(0, Math.min(this.selected - bodyHeight + 1, candidates.length - bodyHeight));
		const position = this.theme.fg("dim", ` ${this.selected + 1}/${candidates.length}`);
		const lines = [
			this.frame(`${this.theme.fg(color, this.theme.bold(`Edit role: ${this.name}`))}${position}`, innerWidth),
			this.frame(
				this.theme.fg(
					"muted",
					`${color}  ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${
						this.name === this.catalog.defaultRole ? "  ·  default" : ""
					}`,
				),
				innerWidth,
			),
			this.frame("", innerWidth),
		];
		for (const [offset, candidate] of candidates.slice(start, start + bodyHeight).entries()) {
			const index = start + offset;
			lines.push(
				this.frame(this.renderCandidate(candidate, index, index === this.selected, color, innerWidth), innerWidth),
			);
		}
		if (this.busy) lines.push(this.frame(this.theme.fg("dim", "Working..."), innerWidth));
		else lines.push(this.frame("", innerWidth));
		lines.push(
			this.frame(
				this.theme.fg(
					"dim",
					truncateToWidth(
						"↑↓/jk select  enter/e model  t thinking  m mode  c color  a add  x remove  q done",
						innerWidth,
					),
				),
				innerWidth,
			),
		);
		lines.push(this.bottom(innerWidth));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.busy = true;
	}

	private role(): ModelRole {
		return this.catalog.roles[this.name]!;
	}

	private candidate(): RoleCandidate | undefined {
		return this.role().candidates[this.selected];
	}

	private move(delta: number): void {
		const count = this.role().candidates.length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		this.tui.requestRender();
	}

	private select(index: number): void {
		const count = this.role().candidates.length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, index));
		this.tui.requestRender();
	}

	private async editSelected(): Promise<void> {
		const current = this.candidate();
		if (!current) return;
		await this.run(async () => {
			const candidate = await editCandidate(this.ctx, current);
			if (candidate) {
				this.role().candidates[this.selected] = candidate;
				this.save();
			}
		});
	}

	private async changeThinking(): Promise<void> {
		const candidate = this.candidate();
		if (!candidate) return;
		await this.run(async () => {
			const selected = await openChoicePicker(
				this.ctx,
				"Thinking level",
				thinkingLevels(this.ctx, candidate),
				candidate.thinking,
			);
			if (!selected) return;
			candidate.thinking = selected as ThinkingLevel;
			this.save();
		});
	}

	private async changeMode(): Promise<void> {
		const candidate = this.candidate();
		if (!candidate) return;
		await this.run(async () => {
			const current = candidate.service_tier ?? "off";
			const selected = await openChoicePicker(
				this.ctx,
				"Mode",
				modeOptions(candidate),
				current === "priority" ? "priority (fast)" : current,
			);
			if (!selected) return;
			if (selected === "off") delete candidate.service_tier;
			else candidate.service_tier = selected.replace(/ \(fast\)$/, "");
			this.save();
		});
	}

	private async changeColor(): Promise<void> {
		const role = this.role();
		const current = roleColor(role, Math.max(0, roleNames(this.catalog).indexOf(this.name)));
		await this.run(async () => {
			const selected = await openChoicePicker(this.ctx, "Role color", [...ROLE_COLORS], current);
			if (!selected) return;
			role.color = selected as ModelRole["color"];
			this.save();
		});
	}

	private async addCandidate(): Promise<void> {
		await this.run(async () => {
			const candidate = await editCandidate(this.ctx);
			if (!candidate) return;
			this.role().candidates.push(candidate);
			this.selected = this.role().candidates.length - 1;
			this.save();
		});
	}

	private async removeSelected(): Promise<void> {
		const role = this.role();
		if (role.candidates.length <= 1) {
			this.ctx.ui.notify("Keep at least one candidate.", "warning");
			return;
		}
		await this.run(async () => {
			if ((await openChoicePicker(this.ctx, "Remove selected candidate?", ["Yes", "No"], "No")) !== "Yes") return;
			role.candidates.splice(this.selected, 1);
			this.selected = Math.min(this.selected, role.candidates.length - 1);
			this.save();
		});
	}

	private save(): void {
		saveModelRoles(this.catalog);
		this.ctx.ui.notify(`Saved role "${this.name}".`, "info");
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
			this.overlayHandle?.setHidden(false);
			this.tui.requestRender();
		}
	}

	private renderCandidate(
		candidate: RoleCandidate,
		index: number,
		selected: boolean,
		color: string,
		width: number,
	): string {
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		const roleText = this.theme.fg(color, this.theme.bold(this.name));
		const modelText = selected ? this.theme.bold(candidate.model) : candidate.model;
		const thinking = this.theme.fg(THINKING_COLORS[candidate.thinking], candidate.thinking);
		const mode = candidate.service_tier === "priority" ? "fast" : (candidate.service_tier ?? "standard");
		const modeText = this.theme.fg(mode === "fast" ? "success" : "muted", mode);
		const raw = ` ${cursor} ${index + 1}. ${roleText} ${this.theme.fg("dim", "·")} ${modelText} ${thinking} ${modeText}`;
		const clipped = truncateToWidth(raw, width);
		const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return selected ? this.theme.bg("selectedBg", padded) : padded;
	}

	private frame(content: string, width: number): string {
		const clipped = truncateToWidth(content, width);
		return `${this.theme.fg("accent", "│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${this.theme.fg("accent", "│")}`;
	}

	private bottom(width: number): string {
		return this.theme.fg("accent", `└${"─".repeat(Math.max(0, width))}┘`);
	}
}

async function selectRoleName(
	ctx: ExtensionContext,
	catalog: ModelRoleCatalog,
	title: string,
): Promise<string | undefined> {
	const names = roleNames(catalog);
	const labels = new Map<string, string>();
	const options = names.map((name) => {
		const label = formatModelRoleOption(name, catalog.roles[name]!, name === catalog.defaultRole);
		labels.set(label, name);
		return label;
	});
	const selected = await openChoicePicker(ctx, title, options);
	return selected ? labels.get(selected) : undefined;
}

export async function editModelRole(ctx: ExtensionContext, catalog: ModelRoleCatalog, name: string): Promise<void> {
	if (!catalog.roles[name]) return;
	await openRoleEditor(ctx, catalog, name);
}

export async function addModelRole(ctx: ExtensionContext, catalog: ModelRoleCatalog): Promise<string | undefined> {
	const name = (await ctx.ui.input("New role name", "focused"))?.trim();
	if (!name) return undefined;
	if (!validRoleName(name)) {
		ctx.ui.notify("Role name must start with a letter and use letters, numbers, ., _, or -.", "warning");
		return undefined;
	}
	if (catalog.roles[name]) {
		ctx.ui.notify(`Role "${name}" already exists.`, "warning");
		return undefined;
	}
	const candidate = await editCandidate(ctx);
	if (!candidate) return undefined;
	if (Object.keys(catalog.roles).length === 0) catalog.defaultRole = name;
	const color = nextRoleColor(catalog);
	catalog.roles[name] = { candidates: [candidate], color };
	saveModelRoles(catalog);
	ctx.ui.notify(`Added role "${name}".`, "info");
	return name;
}

async function setDefaultRole(ctx: ExtensionContext, catalog: ModelRoleCatalog): Promise<void> {
	const name = await selectRoleName(ctx, catalog, "Default role");
	if (!name) return;
	setModelRoleDefault(catalog, name);
	ctx.ui.notify(`Default role: ${name}`, "info");
}

export function setModelRoleDefault(catalog: ModelRoleCatalog, name: string): boolean {
	if (!catalog.roles[name]) return false;
	catalog.defaultRole = name;
	saveModelRoles(catalog);
	return true;
}

async function deleteRole(ctx: ExtensionContext, catalog: ModelRoleCatalog): Promise<void> {
	const name = await selectRoleName(ctx, catalog, "Delete role");
	if (name) await deleteModelRole(ctx, catalog, name);
}

export async function deleteModelRole(
	ctx: ExtensionContext,
	catalog: ModelRoleCatalog,
	name: string,
): Promise<boolean> {
	if (roleNames(catalog).length <= 1) {
		ctx.ui.notify("Keep at least one model role.", "warning");
		return false;
	}
	if ((await openChoicePicker(ctx, `Delete role "${name}"?`, ["Yes", "No"])) !== "Yes") return false;
	delete catalog.roles[name];
	if (catalog.defaultRole === name) catalog.defaultRole = roleNames(catalog)[0]!;
	saveModelRoles(catalog);
	ctx.ui.notify(`Deleted role "${name}".`, "info");
	return true;
}

export async function editModelRoles(ctx: ExtensionContext, catalog: ModelRoleCatalog): Promise<void> {
	if (!ctx.hasUI) return;
	for (;;) {
		const action = await openChoicePicker(ctx, "Configure model roles", [
			"Add role",
			"Edit role",
			"Set default role",
			"Delete role",
			DONE,
		]);
		if (!action || action === DONE) return;
		if (action === "Add role") await addModelRole(ctx, catalog);
		else if (action === "Edit role") {
			const name = await selectRoleName(ctx, catalog, "Edit role");
			if (name) await editModelRole(ctx, catalog, name);
		} else if (action === "Set default role") await setDefaultRole(ctx, catalog);
		else if (action === "Delete role") await deleteRole(ctx, catalog);
	}
}
