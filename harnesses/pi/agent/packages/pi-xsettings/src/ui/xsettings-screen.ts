import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type KeyId,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	BackgroundSurface,
	backgroundAnsiAtColumn,
	ComponentStack,
	type DialogHost,
	icon,
	keyHintGlyph,
	offsetDialogHost,
	SemanticInput,
	type TuiIconName,
	tuiTheme,
} from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { SettingApply, SettingCategory, SettingOption, SettingPage, SettingValue } from "../protocol/settings.ts";
import { settingOptionsFromValue } from "../runtime/options.ts";
import { type SettingField, SettingsEditor } from "./settings-editor.ts";

interface SettingsPage {
	id: SettingPage;
	label: string;
	icon: TuiIconName;
}

function pages(): SettingsPage[] {
	return [
		{ id: "ui", label: "UI", icon: "appearance" },
		{ id: "editor", label: "Editor", icon: "edit" },
		{ id: "ux", label: "UX", icon: "ux" },
		{ id: "animations", label: "Animations", icon: "animations" },
		{ id: "terminal", label: "Terminal", icon: "code-mode" },
		{ id: "behavior", label: "Behavior", icon: "behavior" },
		{ id: "interaction", label: "Interaction", icon: "interaction" },
		{ id: "tools", label: "Tools", icon: "tools" },
	];
}

function pageLabel(page: SettingsPage): string {
	return `${icon(page.icon)} ${page.label}`;
}

function pageFor(field: Pick<SettingsScreenField, "category" | "page">): SettingPage {
	return field.page ?? (field.category === "appearance" ? "ui" : field.category);
}

interface SidebarEntry {
	kind: "page" | "section";
	page: SettingsPage;
	section?: string;
	fieldId?: string;
}

export type SettingsScreenField = SettingField & {
	apply?: SettingApply;
	category: SettingCategory;
	page?: SettingPage;
	storagePath: string[];
};

class RenderedLines implements Component {
	constructor(private readonly lines: readonly string[]) {}
	handleInput(): void {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

class SidebarSearch implements Component, Focusable {
	private _focused = false;
	private readonly input: SemanticInput;
	private readonly theme: Theme;

	constructor(
		theme: Theme,
		private readonly onChange: () => void,
		onSubmit: () => void,
		onEscape: () => void,
	) {
		this.theme = theme;
		this.input = new SemanticInput(theme);
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onEscape;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	getValue(): string {
		return this.input.getValue();
	}

	setValue(value: string): void {
		this.input.setValue(value);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.onChange();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const query = this.input.getValue();
		const colors = tuiTheme(this.theme);
		if (!this._focused) {
			return [this.renderSurface(colors.fg("text.secondary", `${icon("search")} ${query || "Search..."}`), width)];
		}
		const line = this.input.render(Math.max(1, width - 2))[0] ?? "";
		const value = line.startsWith("> ") ? line.slice(2) : line;
		return [this.renderSurface(`${icon("search")} ${value}`, width)];
	}

	private renderSurface(content: string, width: number): string {
		const clipped = truncateToWidth(content, width, "");
		return tuiTheme(this.theme).bg("surface.editor", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
	}
}

class PageColumns implements Component {
	private editor!: SettingsEditor;
	private _focused = false;
	private bodyOffset = 0;
	private renderedWidth = 0;
	private sidebarStart = 0;
	private sidebarVisibleCount = 0;
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly activePage: () => SettingPage,
		private readonly entries: () => readonly SidebarEntry[],
		private readonly selectedEntry: () => number,
		private readonly activeEntry: () => number,
		private readonly sidebarFocused: () => boolean,
		private readonly onSelect: (entry: SidebarEntry) => void,
		private readonly search: SidebarSearch,
		private readonly searchActive: () => boolean,
		private readonly onSearchFocus: () => void,
		private readonly sidebarHint: (width: number) => string,
		private readonly contentHint: (width: number) => string,
		private readonly requestRender: () => void,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateFocus();
	}

	setEditor(editor: SettingsEditor): void {
		this.editor = editor;
		this.updateFocus();
	}

	setSearchActive(active: boolean): void {
		this.search.focused = this._focused && active;
		this.editor.focused = this._focused && !active && !this.sidebarFocused();
	}

	private updateFocus(): void {
		this.setSearchActive(this.searchActive());
	}

	getBodyOffset(): number {
		return this.bodyOffset;
	}

	handleInput(): void {}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		const entries = this.entries();
		const sidebarWidth = Math.min(
			22,
			Math.max(
				12,
				...entries.map((entry) =>
					entry.kind === "section"
						? visibleWidth(`   ${entry.section ?? ""}`) + 2
						: visibleWidth(pageLabel(entry.page)) + 2,
				),
			),
			Math.max(0, width - 4),
		);
		this.renderedWidth = Math.max(0, width);
		this.bodyOffset = Math.min(this.renderedWidth, sidebarWidth + 1);
		const bodyWidth = Math.max(1, this.renderedWidth - this.bodyOffset);
		const body = this.editor.render(bodyWidth);
		const searchLines = this.search.render(sidebarWidth);
		const visibleEntryCount = Math.max(1, body.length - searchLines.length);
		this.sidebarVisibleCount = visibleEntryCount;
		const maxStart = Math.max(0, entries.length - visibleEntryCount);
		this.sidebarStart = Math.min(maxStart, Math.max(0, this.selectedEntry() - Math.max(0, visibleEntryCount - 1)));
		const visibleEntries = entries.slice(this.sidebarStart, this.sidebarStart + visibleEntryCount);
		const height = Math.max(body.length + 1, searchLines.length + visibleEntries.length + 1);
		const colors = tuiTheme(this.theme);
		const focusedSurface = colors.mixForeground(colors.color("surface.inset"), colors.color("surface.selected"), 0.5);
		const sidebarBackground = this.sidebarFocused() ? focusedSurface : colors.color("surface.inset");
		const contentBackground = this.sidebarFocused() ? colors.color("surface.inset") : focusedSurface;
		const sidebarHintBackground = colors.mixForeground(sidebarBackground, colors.color("surface.selected"), 0.22);
		const contentHintBackground = colors.mixForeground(contentBackground, colors.color("surface.selected"), 0.22);
		const hintForeground = colors.mixForeground(colors.color("text.muted"), colors.color("text.secondary"), 0.6);
		const subcategoryText = colors.mixForeground(colors.color("text.secondary"), colors.color("text.primary"), 0.55);
		const hintRow = (text: string, rowWidth: number, background: typeof sidebarHintBackground): string => {
			const clipped = truncateToWidth(colors.fg(hintForeground, text), rowWidth, "");
			return colors.bg(background, clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped))));
		};
		const sidebarRows = Array.from({ length: height }, (_, row) => {
			if (row === height - 1) return hintRow(this.sidebarHint(sidebarWidth), sidebarWidth, sidebarHintBackground);
			const entryIndex = this.sidebarStart + row - searchLines.length;
			const entry = visibleEntries[row - searchLines.length];
			const active = entry?.page.id === this.activePage();
			const selected = this.sidebarFocused() && entryIndex === this.selectedEntry();
			const current = !this.searchActive() && entryIndex === this.activeEntry();
			const sidebarContent =
				row < searchLines.length
					? (searchLines[row] ?? "")
					: entry
						? (() => {
								const marker = current ? `${icon("selection")} ` : "  ";
								const label = entry.kind === "section" ? ` ${marker}${entry.section ?? ""}` : pageLabel(entry.page);
								if (selected) return this.theme.bold(colors.fg("accent", label));
								if (entry.kind === "section") {
									return colors.fg(subcategoryText, label);
								}
								if (active) return this.theme.bold(colors.fg("accent", label));
								return colors.fg("text.primary", label);
							})()
						: "";
			const styled = sidebarContent;
			const sidebar = truncateToWidth(styled, sidebarWidth, "");
			const padded = sidebar + " ".repeat(Math.max(0, sidebarWidth - visibleWidth(sidebar)));
			const painted = current
				? colors.bg("surface.selected", padded)
				: selected || this.hoverIndex === entryIndex
					? colors.bg("surface.hover", padded)
					: padded;
			return painted;
		});
		const sidebar = new BackgroundSurface({
			theme: this.theme,
			component: new RenderedLines(sidebarRows),
			background: sidebarBackground,
		}).render(sidebarWidth);
		const contentRows = Array.from({ length: height }, (_, row) => {
			if (row === height - 1) return hintRow(this.contentHint(bodyWidth), bodyWidth, contentHintBackground);
			return body[row] ?? "";
		});
		const content = new BackgroundSurface({
			theme: this.theme,
			component: new RenderedLines(contentRows),
			background: contentBackground,
		}).render(bodyWidth);
		return Array.from({ length: height }, (_, row) => {
			const contentRow = content[row] ?? colors.bg(contentBackground, " ");
			const contentCell = truncateToWidth(contentRow, 1, "");
			const first = stripTerminalSequences(contentCell).at(0);
			const separator =
				first === "─" || first === "▄" || first === "▀"
					? contentCell
					: `${backgroundAnsiAtColumn(contentRow, 0)} \x1b[49m`;
			return truncateToWidth(`${sidebar[row] ?? ""}${separator}${content[row] ?? ""}`, this.renderedWidth, "");
		});
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") {
			const changed = this.hoverIndex !== undefined || this.pressedIndex !== undefined;
			this.hoverIndex = undefined;
			this.pressedIndex = undefined;
			this.editor.onMouse({ ...event, col: event.col - this.bodyOffset });
			if (changed) this.requestRender();
			return false;
		}
		if (event.type === "wheel") {
			return this.editor.onMouse({ ...event, col: Math.max(0, event.col - this.bodyOffset) });
		}
		const entries = this.entries();
		if (event.col < this.bodyOffset - 1 && event.row === 0) {
			if (event.type === "press" && event.button === 0 && !this.editor.isEditing()) this.onSearchFocus();
			return true;
		}
		const index =
			event.col < this.bodyOffset - 1 &&
			event.row >= 1 &&
			event.row - 1 < Math.min(entries.length - this.sidebarStart, this.sidebarVisibleCount)
				? event.row - 1
				: -1;
		if (index >= 0) {
			const absoluteIndex = this.sidebarStart + index;
			this.editor.onMouse({ ...event, type: "leave", col: event.col - this.bodyOffset });
			if (this.hoverIndex !== absoluteIndex) {
				this.hoverIndex = absoluteIndex;
				this.requestRender();
			}
			if (event.type === "press" && event.button === 0) this.pressedIndex = absoluteIndex;
			if (event.type === "release" && event.button === 0) {
				const pressed = this.pressedIndex;
				this.pressedIndex = undefined;
				const entry = entries[absoluteIndex];
				if (pressed === absoluteIndex && entry) this.onSelect(entry);
			}
			return true;
		}
		if (this.hoverIndex !== undefined) {
			this.hoverIndex = undefined;
			this.requestRender();
		}
		return event.col >= this.bodyOffset ? this.editor.onMouse({ ...event, col: event.col - this.bodyOffset }) : false;
	}
}

export class XSettingsScreen extends ComponentStack {
	private fields: SettingsScreenField[];
	private activePage: SettingPage;
	private sidebarCursor = 0;
	private sidebarFocused = false;
	private searchActive = false;
	private readonly search: SidebarSearch;
	private editor!: SettingsEditor;
	private readonly pageColumns: PageColumns;

	constructor(
		fields: readonly SettingsScreenField[],
		private readonly theme: Theme,
		private readonly onChange: (id: string, value: SettingValue) => void,
		private readonly onReset: (id: string) => void,
		private readonly onClose: () => void,
		private readonly height: number | (() => number) = 24,
		private readonly modelOptions: readonly SettingOption[] = [],
		initialFieldId?: string,
		private readonly dialogHost?: DialogHost,
		private readonly requestRender: () => void = () => {},
		private readonly sidebarToggleKey?: KeyId,
		private readonly onPreview?: (id: string, value: SettingValue) => void,
	) {
		super([], { height, anchorLastChild: true });
		this.fields = [...fields];
		this.search = new SidebarSearch(
			theme,
			() => this.applySearch(),
			() => this.finishSearch(),
			() => {
				this.clearSearch();
				this.sidebarFocused = false;
				this.pageColumns.setSearchActive(false);
			},
		);
		this.activePage = pageFor(
			fields.find((field) => field.id === initialFieldId) ?? fields[0] ?? { category: "appearance" },
		);
		this.pageColumns = new PageColumns(
			theme,
			() => this.activePage,
			() => this.sidebarEntries(),
			() => this.sidebarCursor,
			() => this.activeSidebarEntry(),
			() => this.sidebarFocused,
			(entry) => this.selectSidebarEntry(entry),
			this.search,
			() => this.searchActive,
			() => this.setSearchActive(true),
			(width) => this.sidebarNavigationHint(width),
			(width) => this.contentNavigationHint(width),
			requestRender,
		);
		this.rebuild(initialFieldId);
	}

	private keyHint(key: KeyId | undefined): string {
		return key ? keyHintGlyph(key) : "";
	}

	private hint(width: number, entries: ReadonlyArray<[readonly (KeyId | undefined)[], string]>): string {
		const rendered = entries
			.map(([keys, label]) => [keys.filter((key): key is KeyId => key !== undefined), label] as const)
			.filter(([keys]) => keys.length > 0)
			.map(([keys, label]) => `${keys.map((key) => this.keyHint(key)).join("/")} ${label}`)
			.join(" · ");
		return truncateToWidth(rendered, width, "");
	}

	private sidebarNavigationHint(width: number): string {
		const keybindings = getKeybindings();
		if (this.searchActive) {
			return this.hint(width, [
				[[keybindings.getKeys("tui.select.confirm")[0]], "results"],
				[[keybindings.getKeys("tui.select.cancel")[0]], "clear"],
			]);
		}
		if (!this.sidebarFocused) return this.hint(width, [[[this.sidebarToggleKey ?? "tab"], "focus"]]);
		return this.hint(width, [
			[[keybindings.getKeys("tui.select.confirm")[0]], "switch"],
			[[keybindings.getKeys("tui.select.up")[0], keybindings.getKeys("tui.select.down")[0]], "move"],
			[["/"], "search"],
		]);
	}

	private contentNavigationHint(width: number): string {
		if (this.editor?.isEditing()) return "";
		const keybindings = getKeybindings();
		if (this.sidebarFocused || this.searchActive) {
			return this.hint(width, [[[this.sidebarToggleKey ?? "tab"], "focus"]]);
		}
		return this.hint(width, [
			[[keybindings.getKeys("tui.select.confirm")[0]], "change"],
			[["backspace"], "reset"],
		]);
	}

	toggleCursor(): void {
		if (this.editor.isEditing()) return;
		this.searchActive = false;
		this.sidebarFocused = !this.sidebarFocused;
		this.pageColumns.setSearchActive(false);
		this.requestRender();
	}

	handleInput(data: string): void {
		if (this.editor.isEditing()) {
			this.editor.handleInput(data);
		} else if (matchesKey(data, this.sidebarToggleKey ?? "tab")) {
			this.toggleCursor();
		} else if (this.searchActive) {
			this.search.handleInput(data);
		} else if (data === "/") {
			this.setSearchActive(true);
		} else if (this.sidebarFocused) {
			this.handleSidebarInput(data);
		} else if (!this.editor.handleInput(data)) {
			if (matchesKey(data, "right") || data === "l") this.movePage(1);
			else if (matchesKey(data, "left") || data === "h") this.movePage(-1);
		}
		if (!this.sidebarFocused && !this.searchActive) this.syncSidebarSelection();
		this.requestRender();
	}

	invalidate(): void {
		super.invalidate();
	}

	render(width: number): string[] {
		this.refreshLayout();
		return super.render(width);
	}

	private rebuild(initialFieldId?: string): void {
		this.editor?.dispose();
		const editorDialogs = this.dialogHost
			? offsetDialogHost(this.dialogHost, () => {
					const span = this.getSpans().find((candidate) => candidate.component === this.pageColumns);
					return { row: span?.row ?? 0, col: this.pageColumns.getBodyOffset() };
				})
			: undefined;
		this.editor = new SettingsEditor(
			this.visibleFields(),
			this.theme,
			(id, value) => {
				this.updateField(id, value, true);
				this.onChange(id, value);
			},
			(id) => {
				const field = this.fields.find((candidate) => candidate.id === id);
				if (field) this.updateField(id, field.defaultValue, false);
				this.onReset(id);
			},
			this.onClose,
			() => Math.max(4, (typeof this.height === "function" ? this.height() : this.height) - 1),
			this.modelOptions,
			initialFieldId,
			editorDialogs,
			this.requestRender,
			pageLabel(pages().find((page) => page.id === this.activePage)!),
			this.onPreview,
		);
		this.pageColumns.setEditor(this.editor);
		this.syncSidebarSelection(initialFieldId);
		this.refreshLayout();
	}

	private sidebarEntries(): SidebarEntry[] {
		const result: SidebarEntry[] = [];
		for (const page of pages()) {
			result.push({ kind: "page", page });
			const sections: Array<{ section: string; fieldId: string }> = [];
			const seen = new Set<string>();
			for (const field of this.fields) {
				if (pageFor(field) !== page.id) continue;
				const section = field.section ?? "General";
				if (seen.has(section)) continue;
				seen.add(section);
				sections.push({ section, fieldId: field.id });
			}
			for (const entry of sections) {
				result.push({
					kind: "section",
					page,
					section: entry.section,
					fieldId: entry.fieldId,
				});
			}
		}
		return result;
	}

	private handleSidebarInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.moveSidebar(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.moveSidebar(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			const entry = this.sidebarEntries()[this.sidebarCursor];
			if (entry) this.selectSidebarEntry(entry);
			return;
		}
		if (matchesKey(data, "left") || data === "h") this.movePage(-1);
		else if (matchesKey(data, "right") || data === "l") this.movePage(1);
	}

	private moveSidebar(delta: number): void {
		const entries = this.sidebarEntries();
		if (entries.length === 0) return;
		this.sidebarCursor = (this.sidebarCursor + delta + entries.length) % entries.length;
		const entry = entries[this.sidebarCursor];
		if (entry?.kind === "section") this.selectSidebarEntry(entry, false);
	}

	private visibleFields(): SettingsScreenField[] {
		const query = this.search.getValue().toLowerCase().trim().split(/\s+/u).filter(Boolean);
		if (query.length === 0) return this.fields.filter((field) => pageFor(field) === this.activePage);
		return this.fields.filter((field) => {
			const page = pages().find((candidate) => candidate.id === pageFor(field));
			const text = `${page?.label ?? ""} ${field.section ?? ""} ${field.label} ${field.description}`.toLowerCase();
			return query.every((token) => text.includes(token));
		});
	}

	private applySearch(): void {
		if (!this.editor) return;
		this.editor.setFields(this.visibleFields());
	}

	private setSearchActive(active: boolean): void {
		if (active && this.editor?.isEditing()) return;
		if (active) this.sidebarFocused = true;
		this.searchActive = active;
		this.pageColumns?.setSearchActive(active);
	}

	private clearSearch(): void {
		this.search.setValue("");
		this.setSearchActive(false);
		this.applySearch();
	}

	private finishSearch(): void {
		this.setSearchActive(false);
		this.sidebarFocused = false;
		this.pageColumns.setSearchActive(false);
	}

	dispose(): void {
		this.editor?.dispose();
	}

	private refreshLayout(): void {
		this.setChildren([this.pageColumns]);
		this.setActiveChild(this.pageColumns);
	}

	private movePage(delta: number): void {
		const definitions = pages();
		const index = definitions.findIndex((page) => page.id === this.activePage);
		this.selectPage(definitions[(index + delta + definitions.length) % definitions.length]!.id);
	}

	private selectPage(page: SettingPage): void {
		if (this.editor?.isEditing()) return;
		if (page === this.activePage) {
			if (this.search.getValue()) this.clearSearch();
			this.syncSidebarSelection();
			return;
		}
		this.clearSearch();
		this.activePage = page;
		this.rebuild();
	}

	private selectSidebarEntry(entry: SidebarEntry, focusContent = true): void {
		if (this.editor.isEditing()) return;
		this.sidebarCursor = this.sidebarEntries().findIndex(
			(candidate) =>
				candidate.kind === entry.kind && candidate.page.id === entry.page.id && candidate.section === entry.section,
		);
		this.sidebarFocused = !focusContent;
		this.pageColumns.setSearchActive(false);
		if (entry.kind === "section" && entry.fieldId) {
			if (entry.page.id !== this.activePage) {
				this.clearSearch();
				this.activePage = entry.page.id;
				this.rebuild(entry.fieldId);
			} else {
				this.clearSearch();
				this.editor.selectField(entry.fieldId);
			}
			return;
		}
		this.selectPage(entry.page.id);
	}

	private activeSidebarEntry(fieldId = this.editor?.getSelectedFieldId()): number {
		const entries = this.sidebarEntries();
		const field = fieldId ? this.fields.find((candidate) => candidate.id === fieldId) : undefined;
		const section = field?.section ?? (field ? "General" : undefined);
		const fieldPage = field ? pageFor(field) : this.activePage;
		const sectionIndex = section
			? entries.findIndex(
					(entry) => entry.kind === "section" && entry.page.id === fieldPage && entry.section === section,
				)
			: -1;
		const pageIndex = entries.findIndex((entry) => entry.kind === "page" && entry.page.id === this.activePage);
		return sectionIndex >= 0 ? sectionIndex : pageIndex;
	}

	private syncSidebarSelection(fieldId = this.editor?.getSelectedFieldId()): void {
		const active = this.activeSidebarEntry(fieldId);
		if (active >= 0) this.sidebarCursor = active;
	}

	private updateField(id: string, value: SettingValue, configured: boolean): void {
		this.fields = this.fields.map((field) =>
			field.id === id ? ({ ...field, value, configured } as SettingsScreenField) : field,
		);
		this.fields = this.fields.map((field): SettingsScreenField => {
			if (field.type !== "enum" || !field.optionsFrom || field.optionsFrom.fieldId !== id || !Array.isArray(value))
				return field;
			const source = field.optionsFrom;
			const options = settingOptionsFromValue(value, source.itemField).map(({ value: optionValue, ...option }) => ({
				...option,
				value: String(optionValue),
			}));
			const nextValue = options.some((option) => option.value === field.value)
				? field.value
				: (options[0]?.value ?? field.value);
			return { ...field, options, value: nextValue };
		});
	}
}
