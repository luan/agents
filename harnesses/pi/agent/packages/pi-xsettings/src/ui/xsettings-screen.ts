import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	DialogButtonBar,
	type DialogHost,
	icon,
	offsetDialogHost,
	tuiTheme,
	type TuiIconName,
} from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { SettingCategory, SettingOption, SettingPage, SettingValue } from "../protocol/settings.ts";
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

export type SettingsScreenField = SettingField & {
	category: SettingCategory;
	page?: SettingPage;
	storagePath: string[];
};

class RenderLine implements Component {
	constructor(private readonly line: (width: number) => string) {}
	handleInput(): void {}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.line(width)];
	}
}

class PageColumns implements Component {
	private editor!: SettingsEditor;
	private bodyOffset = 0;
	private renderedWidth = 0;
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly activePage: () => SettingPage,
		private readonly onSelect: (page: SettingPage) => void,
		private readonly requestRender: () => void,
	) {}

	setEditor(editor: SettingsEditor): void {
		this.editor = editor;
	}

	getBodyOffset(): number {
		return this.bodyOffset;
	}

	handleInput(): void {}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		const definitions = pages();
		const sidebarWidth = Math.min(
			16,
			Math.max(10, ...definitions.map((page) => visibleWidth(pageLabel(page)) + 2)),
			Math.max(0, width - 4),
		);
		this.renderedWidth = Math.max(0, width);
		this.bodyOffset = Math.min(this.renderedWidth, sidebarWidth + 3);
		const bodyWidth = Math.max(1, this.renderedWidth - this.bodyOffset);
		const body = this.editor.render(bodyWidth);
		const height = Math.max(body.length, definitions.length);
		const colors = tuiTheme(this.theme);
		return Array.from({ length: height }, (_, row) => {
			const definition = definitions[row];
			const active = definition?.id === this.activePage();
			const label = definition ? `${active ? "›" : " "} ${pageLabel(definition)}` : "";
			const styled = active
				? this.theme.bold(colors.fg("accent", label))
				: row === this.hoverIndex
					? colors.fg("text.secondary", label)
					: colors.fg("text.muted", label);
			const sidebar = truncateToWidth(styled, sidebarWidth, "");
			const padded = sidebar + " ".repeat(Math.max(0, sidebarWidth - visibleWidth(sidebar)));
			return truncateToWidth(`${padded} ${colors.fg("border", "│")} ${body[row] ?? ""}`, this.renderedWidth, "");
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
		const definitions = pages();
		const index = event.col < this.bodyOffset - 2 && event.row >= 0 && event.row < definitions.length ? event.row : -1;
		if (index >= 0) {
			this.editor.onMouse({ ...event, type: "leave", col: event.col - this.bodyOffset });
			if (this.hoverIndex !== index) {
				this.hoverIndex = index;
				this.requestRender();
			}
			if (event.type === "press" && event.button === 0) this.pressedIndex = index;
			if (event.type === "release" && event.button === 0) {
				const pressed = this.pressedIndex;
				this.pressedIndex = undefined;
				const page = definitions[index];
				if (pressed === index && page) this.onSelect(page.id);
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
	private editor!: SettingsEditor;
	private readonly pageColumns: PageColumns;
	private readonly divider: RenderLine;
	private readonly navigationFooter: ComponentStack;
	private readonly editingFooter: ComponentStack;

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
	) {
		super([], { height, anchorLastChild: true });
		this.fields = [...fields];
		this.activePage = pageFor(
			fields.find((field) => field.id === initialFieldId) ?? fields[0] ?? { category: "appearance" },
		);
		this.pageColumns = new PageColumns(
			theme,
			() => this.activePage,
			(page) => this.selectPage(page),
			requestRender,
		);
		this.divider = new RenderLine((width) => this.colors().fg("border", "─".repeat(width)));
		const buttons = new DialogButtonBar({
			theme: this.theme,
			leading: (width) =>
				this.colors().fg(
					"text.muted",
					truncateToWidth("h/l pages · Tab sections · Enter change · / filter · Esc/q close", width, ""),
				),
			buttons: [
				{
					value: "reset",
					label: "Reset",
					icon: "reset",
					foreground: "warning",
					background: "action.warning",
					align: "end",
					shortcuts: ["backspace"],
				},
				{
					value: "close",
					label: "Close",
					icon: "close",
					foreground: "text.primary",
					background: "action.neutral",
					align: "end",
					shortcuts: ["escape", "q"],
				},
			],
			requestRender() {},
			onActivate: (action) => {
				if (action === "reset") this.editor.resetSelected();
				else this.onClose();
			},
		});
		this.navigationFooter = new ComponentStack([this.divider, buttons], { inputMode: "all" });
		this.editingFooter = new ComponentStack([
			this.divider,
			new RenderLine((width) =>
				this.colors().fg(
					"text.muted",
					truncateToWidth("Choose an item or use the editor's Save, Back, and Cancel actions", width, ""),
				),
			),
		]);
		this.rebuild(initialFieldId);
	}

	private colors() {
		return tuiTheme(this.theme);
	}

	handleInput(data: string): void {
		if (!this.editor.handleInput(data)) {
			if (matchesKey(data, "right") || data === "l") this.movePage(1);
			else if (matchesKey(data, "left") || data === "h") this.movePage(-1);
		}
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
			this.fields.filter((field) => pageFor(field) === this.activePage),
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
			() => Math.max(4, (typeof this.height === "function" ? this.height() : this.height) - 2),
			this.modelOptions,
			initialFieldId,
			editorDialogs,
			this.requestRender,
		);
		this.pageColumns.setEditor(this.editor);
		this.refreshLayout();
	}

	dispose(): void {
		this.editor?.dispose();
	}

	private refreshLayout(): void {
		const footer = this.editor.isEditing() ? this.editingFooter : this.navigationFooter;
		this.setChildren([this.pageColumns, footer]);
		this.setActiveChild(this.pageColumns);
	}

	private movePage(delta: number): void {
		const definitions = pages();
		const index = definitions.findIndex((page) => page.id === this.activePage);
		this.selectPage(definitions[(index + delta + definitions.length) % definitions.length]!.id);
	}

	private selectPage(page: SettingPage): void {
		if (page === this.activePage || this.editor?.isEditing()) return;
		this.activePage = page;
		this.rebuild();
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
