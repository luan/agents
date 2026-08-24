import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, visibleWidth } from "@earendil-works/pi-tui";
import { PickerPanel, type PickerOption, type PickerPanelHost, tuiTheme } from "pi-libtui";
import { roleColor } from "../config/role-colors.ts";
import { type ModelRole, type ModelRoleCatalog, type ModelRoleName, roleByName } from "../core/catalog.ts";

const BADGE_WIDTH = 16;

function roleSearchText(role: ModelRole): string {
	return [
		role.name,
		...role.candidates.flatMap((candidate) => [candidate.model, candidate.thinking]),
		role.candidates.length > 1 ? `${role.candidates.length - 1} fallback` : "",
		role.description,
	].join(" ");
}

function roleBadges(name: ModelRoleName, catalog: ModelRoleCatalog, theme: Theme): string {
	const colors = tuiTheme(theme);
	const badges = [
		name === catalog.defaultRole ? colors.fg("warning", "default") : "",
		name === catalog.subagentDefaultRole ? colors.fg("accent", "subagent") : "",
	]
		.filter(Boolean)
		.join("+");
	return `${badges}${" ".repeat(Math.max(0, BADGE_WIDTH - visibleWidth(badges)))}`;
}

function renderRole(role: ModelRole, catalog: ModelRoleCatalog, theme: Theme): string {
	const colors = tuiTheme(theme);
	const candidate = role.candidates[0];
	return [
		roleBadges(role.name, catalog, theme),
		colors.fg(roleColor(role.color), theme.bold(role.name)),
		candidate ? colors.fg("text.muted", candidate.model) : colors.fg("warning", "no model"),
		candidate ? colors.fg("text.muted", candidate.thinking) : "",
		role.candidates.length > 1 ? colors.fg("text.muted", `+${role.candidates.length - 1} fallback`) : "",
		role.description ? colors.fg("text.muted", role.description) : "",
	]
		.filter(Boolean)
		.join("  ");
}

export function createRolePicker(
	tui: PickerPanelHost,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (value: ModelRoleName | undefined) => void,
	selected: ModelRoleName | undefined,
	catalog: ModelRoleCatalog,
): PickerPanel<ModelRoleName> {
	const options: PickerOption<ModelRoleName>[] = catalog.roles.map((role) => ({
		value: role.name,
		label: role.name,
		description: role.description,
		searchText: roleSearchText(role),
	}));
	return new PickerPanel<ModelRoleName>({
		tui,
		theme,
		keybindings,
		title: "Select model role",
		options,
		selected,
		emptyMessage: "No matching roles.",
		renderOption: (option, { theme: rowTheme }) => {
			const role = roleByName(catalog, option.value);
			return role ? renderRole(role, catalog, rowTheme) : option.label;
		},
		onSelect: done,
		onCancel: () => done(undefined),
	});
}

export function openRolePicker(
	ctx: ExtensionContext,
	selected: ModelRoleName | undefined,
	catalog: ModelRoleCatalog,
): Promise<ModelRoleName | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Interactive role selection requires the TUI. Use /role NAME instead.", "warning");
		return Promise.resolve(undefined);
	}
	return ctx.ui.custom<ModelRoleName | undefined>(
		(tui, theme, keybindings, done) => createRolePicker(tui, theme, keybindings, done, selected, catalog),
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-left", width: "100%" },
		},
	);
}
