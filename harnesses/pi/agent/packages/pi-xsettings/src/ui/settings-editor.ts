import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	activityFrame,
	ComponentStack,
	DialogButtonBar,
	type DialogHost,
	type DialogOverlayAnchor,
	type DialogOverlayOptions,
	getTuiAppearance,
	icon,
	isTuiActivityMarkerStyle,
	isTuiShimmerStyle,
	MultiSelect,
	SearchableSelect,
	SelectableList,
	type SelectableListRenderContext,
	type SelectableListRow,
	SemanticInput,
	sharedMotionScheduler,
	type MotionMount,
	tuiTheme,
} from "pi-libtui";
import type {
	ListDefinition,
	SettingOption as ProtocolSettingOption,
	SettingCategory,
	SettingValue,
} from "../protocol/settings.ts";
import { RenderLines } from "./fields.ts";
import { StringListEditor } from "./string-list-editor.ts";
import { StructuredListEditor } from "./structured-list-editor.ts";

export interface SettingOption {
	value: string;
	label: string;
	description?: string;
}

function groupFieldsBySection(fields: readonly SettingField[]): SettingField[] {
	const sections = new Map<string, SettingField[]>();
	for (const field of fields) {
		const section = field.section ?? "General";
		const grouped = sections.get(section);
		if (grouped) grouped.push(field);
		else sections.set(section, [field]);
	}
	return [...sections.values()].flat();
}

interface SettingFieldBase {
	id: string;
	label: string;
	description: string;
	category?: SettingCategory;
	section?: string;
	configured: boolean;
	unsetLabel?: string;
	emptyLabel?: string;
	unsetOnlyDefault?: boolean;
}

export interface ListSettingField extends SettingFieldBase {
	type: "list";
	value: SettingValue[];
	defaultValue: SettingValue[];
	schema: import("typebox").TSchema;
	list: ListDefinition;
}

export interface BooleanSettingField extends SettingFieldBase {
	type: "boolean";
	value: boolean;
	defaultValue: boolean;
}

export interface EnumSettingField extends SettingFieldBase {
	type: "enum";
	value: string;
	defaultValue: string;
	options: readonly SettingOption[];
	/** Original values paired with the string values used by the picker. */
	optionValues?: readonly (number | string)[];
	optionsFrom?: { fieldId: string; itemField: string };
}

export interface StringSettingField extends SettingFieldBase {
	type: "string";
	value: string;
	defaultValue: string;
}

export interface StringListSettingField extends SettingFieldBase {
	type: "string-list";
	value: string[];
	defaultValue: string[];
	minItems: number;
}

export interface MultiEnumSettingField extends SettingFieldBase {
	type: "multi-enum";
	value: string[];
	defaultValue: string[];
	options: readonly SettingOption[];
	ordered: boolean;
}

export type SettingField =
	| BooleanSettingField
	| EnumSettingField
	| StringSettingField
	| StringListSettingField
	| MultiEnumSettingField
	| ListSettingField;

type EditorComponent = Component & { dispose?(): void };

class AnimationSelect extends SearchableSelect<string> {
	private readonly motion: MotionMount;

	constructor(field: EnumSettingField, theme: Theme, done: (value?: string) => void, requestRender: () => void) {
		let now = performance.now();
		const startedAt = now;
		const markerField = field.id === "extensions.pi-libtui.activityMarker";
		const options = field.options.filter((option) =>
			markerField ? isTuiActivityMarkerStyle(option.value) : isTuiShimmerStyle(option.value),
		);
		super({
			title: field.label,
			showTitle: false,
			description: field.description,
			options,
			selected: options.some((option) => option.value === field.value) ? field.value : undefined,
			theme,
			onSelect: done,
			onCancel: () => done(),
			requestRender,
			renderOption: (option, context) => {
				const colors = tuiTheme(context.theme);
				const appearance = getTuiAppearance();
				const frame = activityFrame(colors, option.label, now - startedAt, {
					markerStyle: markerField && isTuiActivityMarkerStyle(option.value) ? option.value : appearance.activityMarker,
					shimmerStyle: !markerField && isTuiShimmerStyle(option.value) ? option.value : appearance.shimmer,
					textTone: context.selected ? "accent" : "text.primary",
				});
				const preview = frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
				const description = option.description ? `  ${colors.fg("text.muted", option.description)}` : "";
				return `${context.selected ? theme.bold(preview) : preview}${description}`;
			},
		});
		this.motion = sharedMotionScheduler.mount(
			{ requestRender },
			{
				cadenceMs: 70,
				onFrame: (next) => {
					now = next;
				},
			},
		);
	}

	dispose(): void {
		this.motion.dispose();
	}
}

function toolOptionSummary(description?: string): string | undefined {
	const firstLine = description
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean)
		?.replace(/^(?:#{1,6}|[-*+])\s+/, "");
	if (!firstLine) return undefined;
	const sentenceEnd = firstLine.search(/[.!?](?:\s|$)/);
	const summary = sentenceEnd < 0 ? firstLine : firstLine.slice(0, sentenceEnd + 1);
	return truncateToWidth(summary, 160, "…");
}

export function formatSettingValue(field: SettingField): string {
	if (!field.configured && field.unsetLabel) return field.unsetLabel;
	switch (field.type) {
		case "boolean":
			return `${icon(field.value ? "toggle-on" : "toggle-off")} ${field.value ? "on" : "off"}`;
		case "enum":
			return field.options.find((option) => option.value === field.value)?.label ?? field.value;
		case "string":
			return field.value || "unset";
		case "string-list":
			return `${field.value.length} item${field.value.length === 1 ? "" : "s"}`;
		case "multi-enum":
			return field.value.length === 0 ? (field.emptyLabel ?? "none") : field.value.join(", ");
		case "list":
			return `${field.value.length} ${field.list.itemLabel.toLowerCase()}${field.value.length === 1 ? "" : "s"}`;
	}
}

function valuesEqual(left: SettingValue, right: SettingValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isDefault(field: SettingField): boolean {
	return !field.configured || (!field.unsetOnlyDefault && valuesEqual(field.value, field.defaultValue));
}

class StringEditor extends ComponentStack {
	private readonly input: SemanticInput;

	constructor(field: StringSettingField, theme: Theme, done: (value?: string) => void, showTitle = true) {
		const colors = tuiTheme(theme);
		const input = new SemanticInput(theme);
		input.setValue(field.value);
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done();
		const buttons = new DialogButtonBar({
			theme,
			leading: () => colors.fg("text.muted", "Enter save · Esc cancel"),
			buttons: [
				{ value: "cancel", label: "Cancel", icon: "cancel", foreground: "text.primary", background: "action.neutral" },
				{ value: "save", label: "Save", icon: "confirm", foreground: "positive", background: "action.positive" },
			],
			requestRender() {},
			onActivate: (action) => (action === "save" ? done(input.getValue()) : done()),
		});
		const children: Component[] = [
			new Text(colors.fg("text.muted", field.description), 0, 0),
			new Spacer(1),
			input,
			new Spacer(1),
			buttons,
		];
		if (showTitle) children.unshift(new Text(theme.bold(colors.fg("accent", field.label)), 0, 0));
		super(children, { activeChild: showTitle ? 3 : 2 });
		this.input = input;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

class FilterView implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly input: SemanticInput,
		private readonly renderLines: (width: number) => string[],
	) {}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
	invalidate(): void {
		this.input.invalidate();
	}
	render(width: number): string[] {
		return this.renderLines(width);
	}
}

export class SettingsEditor extends ComponentStack {
	private fields: SettingField[];
	private filtered: SettingField[];
	private selectedIndex = 0;
	private activeEditor: EditorComponent | undefined;
	private closeActiveEditor: (() => void) | undefined;
	private filterActive = false;
	private readonly filterInput: SemanticInput;
	private readonly list: SelectableList<SettingField>;
	private readonly filterView: FilterView;
	private readonly emptyView = new RenderLines(() => [this.colors().fg("text.muted", "No matching settings")]);
	private descriptionAtBottom = false;
	private readonly descriptionView = new RenderLines((width) => {
		if (!this.descriptionAtBottom) return [];
		const field = this.filtered[this.selectedIndex];
		return field?.description ? [truncateToWidth(this.colors().fg("text.muted", field.description), width, "")] : [];
	});

	constructor(
		fields: readonly SettingField[],
		private readonly theme: Theme,
		private readonly onChange: (id: string, value: SettingValue) => void,
		private readonly onReset: (id: string) => void,
		private readonly onCancel: () => void,
		private readonly maxVisible: number | (() => number) = 18,
		private readonly modelOptions: readonly ProtocolSettingOption[] = [],
		initialFieldId?: string,
		private readonly dialogHost?: DialogHost,
		private readonly requestRender: () => void = () => {},
	) {
		super([], { height: maxVisible, anchorLastChild: true });
		this.filterInput = new SemanticInput(theme);
		this.filterView = new FilterView(this.filterInput, (width) => {
			const query = this.filterInput.getValue();
			if (!this.filterActive && !query) return [];
			const lines = this.filterActive
				? this.filterInput
						.render(Math.max(1, width - 3))
						.map((line) => `/ ${line.startsWith("> ") ? line.slice(2) : line}`)
				: [this.colors().fg("text.muted", `/ ${query}`)];
			return [...lines, ""];
		});
		this.fields = groupFieldsBySection(fields);
		this.filtered = [...this.fields];
		this.selectedIndex = Math.max(
			0,
			this.filtered.findIndex((field) => field.id === initialFieldId),
		);
		this.list = new SelectableList({
			items: this.filtered,
			selectedIndex: this.selectedIndex,
			maxVisible: this.maxVisibleRows(),
			renderItem: (field, context) => this.renderField(field, context),
			requestRender() {},
			onSelectionChange: (_field, index) => {
				this.selectedIndex = index;
			},
			onActivate: () => this.activate(),
		});
		this.filterInput.onSubmit = () => {
			this.filterActive = false;
		};
		this.filterInput.onEscape = () => {
			this.filterInput.setValue("");
			this.applyFilter();
			this.filterActive = false;
		};
	}

	private colors() {
		return tuiTheme(this.theme);
	}

	private maxVisibleRows(): number {
		const maxVisible = typeof this.maxVisible === "function" ? this.maxVisible() : this.maxVisible;
		return Math.max(0, Math.floor(maxVisible));
	}

	handleInput(data: string): boolean {
		if (this.activeEditor) {
			this.activeEditor.handleInput?.(data);
			return true;
		}
		if (this.filterActive) {
			this.filterInput.handleInput(data);
			this.applyFilter();
			return true;
		}
		const keybindings = getKeybindings();
		if (data === "/") {
			this.filterActive = true;
			return true;
		}
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.list.handleInput(data);
			return true;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.list.handleInput(data);
			return true;
		}
		if (matchesKey(data, "tab")) {
			this.moveSection(1);
			return true;
		}
		if (matchesKey(data, "shift+tab")) {
			this.moveSection(-1);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			this.reset();
			return true;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.list.handleInput(data);
			return true;
		}
		if (data === " ") {
			this.activate();
			return true;
		}
		if (keybindings.matches(data, "tui.select.cancel") || data === "q") {
			this.onCancel();
			return true;
		}
		return false;
	}

	invalidate(): void {
		super.invalidate();
	}

	render(width: number): string[] {
		if (this.activeEditor && !this.dialogHost) {
			this.setChildren([this.activeEditor]);
			return super.render(width);
		}
		this.list.setSelectedIndex(this.selectedIndex);
		const hasFilter = this.filterActive || Boolean(this.filterInput.getValue());
		this.descriptionAtBottom = !this.descriptionFitsInline(width);
		const maxVisible = this.maxVisibleRows();
		this.list.setMaxVisible(Math.max(1, maxVisible - (hasFilter ? 2 : 0) - (this.descriptionAtBottom ? 1 : 0)));
		const children: Component[] = [];
		if (hasFilter) children.push(this.filterView);
		children.push(this.filtered.length > 0 ? this.list : this.emptyView);
		children.push(this.descriptionView);
		this.setChildren(children);
		this.setActiveChild(this.filterActive ? this.filterView : this.filtered.length > 0 ? this.list : this.emptyView);
		return super.render(width);
	}

	private renderField(field: SettingField, context: SelectableListRenderContext): SelectableListRow {
		const labelWidth = Math.min(34, Math.max(...this.fields.map((field) => visibleWidth(field.label))) + 2);
		const section = field.section ?? "General";
		const previousSection = this.filtered[context.index - 1]?.section ?? (context.index > 0 ? "General" : undefined);
		const startsSection = context.index === 0 || previousSection !== section;
		const label = truncateToWidth(field.label, Math.max(1, labelWidth - 2), "");
		const padded = label + " ".repeat(Math.max(1, labelWidth - visibleWidth(label)));
		const value = truncateToWidth(formatSettingValue(field), Math.max(1, context.width - labelWidth - 2), "");
		const valueColor = isDefault(field) ? "text.secondary" : "heading";
		const renderedValue = this.colors().fg(valueColor, value);
		const emphasized = context.selected || context.hovered;
		const cursor = context.selected ? this.colors().fg("accent", "› ") : "  ";
		const row = truncateToWidth(
			`${cursor}${emphasized ? this.colors().fg("accent", padded) : padded}${renderedValue}`,
			context.width,
			"",
		);
		const before: string[] = [];
		if (startsSection) {
			before.push(this.theme.underline(this.colors().fg("text.secondary", section)));
		}
		const description =
			context.selected && !this.descriptionAtBottom ? `  ${this.colors().fg("text.muted", field.description)}` : "";
		return {
			before,
			content: `${row}${description}`,
		};
	}

	private descriptionFitsInline(width: number): boolean {
		const field = this.filtered[this.selectedIndex];
		if (!field?.description) return true;
		const labelWidth = Math.min(34, Math.max(...this.fields.map((candidate) => visibleWidth(candidate.label))) + 2);
		return 2 + labelWidth + visibleWidth(formatSettingValue(field)) + 2 + visibleWidth(field.description) <= width;
	}

	private moveSection(delta: number): void {
		if (this.filtered.length === 0) return;
		const sections = [...new Set(this.filtered.map((field) => field.section ?? "General"))];
		const current = this.filtered[this.selectedIndex]?.section ?? "General";
		const index = sections.indexOf(current);
		const next = sections[(index + delta + sections.length) % sections.length];
		const selected = this.filtered.findIndex((field) => (field.section ?? "General") === next);
		if (selected >= 0) {
			this.selectedIndex = selected;
			this.list.setSelectedIndex(selected);
		}
	}

	private activate(): void {
		const field = this.filtered[this.selectedIndex];
		if (!field) return;
		if (field.type === "list") {
			const editor = new StructuredListEditor({
				label: field.label,
				description: field.description,
				value: field.value,
				schema: field.schema,
				list: field.list,
				modelOptions: this.modelOptions,
				theme: this.theme,
				onSave: (value) => {
					this.apply(field.id, value);
					this.closeEditor();
				},
				onCancel: () => this.closeEditor(),
				dialogHost: this.dialogHost,
				showTitle: !this.dialogHost,
			});
			this.openEditor(editor, { title: field.label, width: 76, maxHeight: 20, parent: this.getSelectedDialogAnchor() });
			return;
		}
		if (field.type === "string-list") {
			const editor = new StringListEditor({
				label: field.label,
				description: field.description,
				value: field.value,
				minItems: field.minItems,
				theme: this.theme,
				onSave: (value) => {
					this.apply(field.id, value);
					this.closeEditor();
				},
				onCancel: () => this.closeEditor(),
				dialogHost: this.dialogHost,
				showTitle: !this.dialogHost,
			});
			this.openEditor(editor, { title: field.label, width: 72, maxHeight: 20, parent: this.getSelectedDialogAnchor() });
			return;
		}
		if (field.type === "boolean") {
			this.apply(field.id, !field.value);
			return;
		}
		const done = (value?: string): void => {
			if (value !== undefined) this.apply(field.id, value);
			this.closeEditor();
		};
		if (field.type === "enum") {
			const editor =
				field.id === "extensions.pi-libtui.activityMarker" || field.id === "extensions.pi-libtui.shimmer"
					? new AnimationSelect(field, this.theme, done, this.requestRender)
					: new SearchableSelect({
							title: field.label,
							showTitle: false,
							description: field.description,
							options: field.options,
							selected: field.value,
							theme: this.theme,
							onSelect: done,
							onCancel: () => done(),
							requestRender: this.requestRender,
						});
			this.openEditor(editor, { title: field.label, width: 48, maxHeight: 18, parent: this.getSelectedDialogAnchor() });
		} else if (field.type === "string") {
			this.openEditor(new StringEditor(field, this.theme, done, !this.dialogHost), {
				title: field.label,
				width: 56,
				maxHeight: 12,
				parent: this.getSelectedDialogAnchor(),
			});
		} else {
			const toolOptions =
				field.category === "tools"
					? field.options.map((option) => ({ ...option, description: toolOptionSummary(option.description) }))
					: field.options;
			const editor = new MultiSelect({
				title: field.label,
				showTitle: false,
				description: field.description,
				options: toolOptions,
				value: field.value,
				ordered: field.ordered,
				descriptionLayout: field.category === "tools" ? "below" : "inline",
				theme: this.theme,
				onSave: (value) => {
					this.apply(field.id, value);
					this.closeEditor();
				},
				onCancel: () => this.closeEditor(),
			});
			this.openEditor(editor, {
				title: field.label,
				width: 60,
				maxHeight: "90%",
				parent: this.getSelectedDialogAnchor(),
			});
		}
	}

	private getSelectedDialogAnchor(): DialogOverlayAnchor | undefined {
		const geometry = this.list.getGeometry();
		const item = geometry?.items.find((candidate) => candidate.index === this.selectedIndex);
		const span = this.getSpans().find((candidate) => candidate.component === this.list);
		if (!item || !span) return undefined;
		return {
			row: span.row + item.y,
			col: item.x + Math.min(32, Math.max(0, item.width - 1)),
		};
	}

	private openEditor(editor: EditorComponent, options: DialogOverlayOptions): void {
		this.activeEditor = editor;
		this.closeActiveEditor = this.dialogHost?.open(editor, options);
	}

	private closeEditor(): void {
		const close = this.closeActiveEditor;
		this.activeEditor?.dispose?.();
		this.closeActiveEditor = undefined;
		this.activeEditor = undefined;
		close?.();
	}

	dispose(): void {
		this.closeEditor();
	}

	private applyFilter(): void {
		const selectedId = this.filtered[this.selectedIndex]?.id;
		const tokens = this.filterInput.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
		this.filtered =
			tokens.length > 0
				? this.fields.filter((field) => {
						const text = `${field.section ?? ""} ${field.label} ${field.description}`.toLowerCase();
						return tokens.every((token) => text.includes(token));
					})
				: [...this.fields];
		const retained = selectedId ? this.filtered.findIndex((field) => field.id === selectedId) : -1;
		this.selectedIndex = retained >= 0 ? retained : 0;
		this.list.setItems(this.filtered, this.selectedIndex);
	}

	private apply(id: string, value: SettingValue): void {
		const update = (field: SettingField): SettingField =>
			field.id === id ? ({ ...field, value, configured: true } as SettingField) : field;
		this.fields = this.fields.map(update);
		this.filtered = this.filtered.map(update);
		this.list.setItems(this.filtered, this.selectedIndex);
		this.onChange(id, value);
	}

	private reset(): void {
		const field = this.filtered[this.selectedIndex];
		if (!field || !field.configured) return;
		const update = (candidate: SettingField): SettingField =>
			candidate.id === field.id
				? ({ ...candidate, value: candidate.defaultValue, configured: false } as SettingField)
				: candidate;
		this.fields = this.fields.map(update);
		this.filtered = this.filtered.map(update);
		this.list.setItems(this.filtered, this.selectedIndex);
		this.onReset(field.id);
	}

	resetSelected(): void {
		this.reset();
	}

	isEditing(): boolean {
		return this.activeEditor !== undefined;
	}
}
