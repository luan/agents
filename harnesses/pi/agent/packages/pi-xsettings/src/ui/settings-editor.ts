import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	activityFrame,
	activityPresentationCadenceMs,
	activityPresentationFrame,
	animationSmoothnessCadenceMs,
	BackgroundSurface,
	ComponentStack,
	configuredAnimationCadenceMs,
	DialogButtonBar,
	type DialogHost,
	DialogOverlay,
	type DialogOverlayAnchor,
	type DialogOverlayOptions,
	FloatingOverlay,
	getTuiAppearance,
	halfBlockSurfaceEdge,
	icon,
	isTuiActivityIndicatorStyle,
	isTuiActivityMessageStyle,
	isTuiAnimationSmoothness,
	isTuiAnimationSpeed,
	isTuiPulseEffectStyle,
	isTuiStatusPresentationStyle,
	isTuiTextEffectStyle,
	type MotionMount,
	MultiSelect,
	renderPill,
	resolveActivityPresentation,
	SelectableList,
	type SelectableListRenderContext,
	type SelectableListRow,
	SelectBox,
	SemanticInput,
	sharedMotionScheduler,
	tuiTheme,
} from "pi-libtui";
import { renderEditorCompositionPreview } from "pi-libtui/editor";
import type {
	ListDefinition,
	SettingOption as ProtocolSettingOption,
	SettingCategory,
	SettingPreview,
	SettingValue,
} from "../protocol/settings.ts";
import { RenderLines } from "./fields.ts";
import { StringListEditor } from "./string-list-editor.ts";
import { StructuredListEditor } from "./structured-list-editor.ts";

export interface SettingOption {
	value: string;
	label: string;
	description?: string;
	color?: ProtocolSettingOption["color"];
	preview?: ProtocolSettingOption["preview"];
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
	preview?: SettingPreview;
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

type EditorComponent = Component & { dispose?(): void; setMaxHeight?(height: number): void };

const SETTINGS_DIALOG_MAX_HEIGHT = "90%" as const;

function settingDialogWidth(field: SettingField): number {
	const minimum = field.type === "list" ? 76 : field.type === "string-list" ? 72 : field.type === "string" ? 56 : 48;
	const content = [field.label, field.description];
	if ("options" in field) {
		for (const option of field.options) content.push(option.label, option.description ?? "");
	}
	return Math.min(88, Math.max(minimum, ...content.map((line) => visibleWidth(line) + 6)));
}

class AnimationSelect extends SelectBox<string> {
	private readonly motion?: MotionMount;

	constructor(
		field: EnumSettingField,
		theme: Theme,
		done: (value?: string) => void,
		preview: (value: string) => void,
		requestRender: () => void,
	) {
		let now = performance.now();
		const startedAt = now;
		const indicatorField = field.preview === "activity-marker";
		const messageField = field.preview === "activity-message";
		const presentationField = field.preview === "status-presentation";
		const textEffectField = field.preview === "text-effect";
		const pulseEffectField = field.preview === "pulse-effect";
		const speedField = field.preview === "animation-speed";
		const smoothnessField = field.preview === "animation-smoothness";
		const previewPhase = field.id.includes("thinking") ? "thinking" : field.id.includes("tool") ? "tool" : "working";
		const options = field.options.filter((option) => {
			if (indicatorField) return option.value === "inherit" || isTuiActivityIndicatorStyle(option.value);
			if (messageField) return option.value === "inherit" || isTuiActivityMessageStyle(option.value);
			if (presentationField) return option.value === "inherit" || isTuiStatusPresentationStyle(option.value);
			if (textEffectField) return option.value === "inherit" || isTuiTextEffectStyle(option.value);
			if (pulseEffectField) return option.value === "inherit" || isTuiPulseEffectStyle(option.value);
			if (speedField) return option.value === "inherit" || isTuiAnimationSpeed(option.value);
			return smoothnessField && (option.value === "inherit" || isTuiAnimationSmoothness(option.value));
		});
		const appearance = getTuiAppearance();
		const previewOptions = (value: string) => ({
			indicatorStyle: indicatorField && isTuiActivityIndicatorStyle(value) ? value : appearance.activityIndicator,
			messageStyle: messageField && isTuiActivityMessageStyle(value) ? value : appearance.activityMessage,
			presentationStyle:
				presentationField && isTuiStatusPresentationStyle(value) ? value : appearance.statusPresentation,
			textEffectStyle: textEffectField && isTuiTextEffectStyle(value) ? value : appearance.textEffect,
			pulseEffectStyle: pulseEffectField && isTuiPulseEffectStyle(value) ? value : appearance.pulseEffect,
			smoothness: smoothnessField && isTuiAnimationSmoothness(value) ? value : appearance.animationSmoothness,
			speed: speedField && isTuiAnimationSpeed(value) ? value : appearance.animationSpeed,
		});
		super({
			bordered: false,
			options,
			selected: options.some((option) => option.value === field.value) ? field.value : undefined,
			theme,
			onSelect: done,
			onPreview: preview,
			onCancel: () => done(),
			requestRender,
			renderOption: (option, context) => {
				if (context.query) return context.highlight(option.label);
				const colors = tuiTheme(context.theme);
				const {
					indicatorStyle,
					messageStyle,
					presentationStyle,
					pulseEffectStyle,
					textEffectStyle,
					smoothness,
					speed,
				} = previewOptions(option.value);
				if (messageField || presentationField) {
					const lineWidth = Math.max(10, Math.min(32, context.width - option.label.length - 3));
					const presentation = resolveActivityPresentation(
						indicatorStyle,
						messageStyle,
						textEffectStyle,
						appearance.textEffectScope,
						pulseEffectStyle,
						presentationStyle,
					);
					const frame = activityPresentationFrame(
						colors,
						presentation,
						previewPhase,
						option.label,
						now - startedAt,
						lineWidth,
						{
							animationSpeed: speed,
							animationSmoothness: smoothness,
						},
					);
					const rendered = frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
					const preview =
						presentation.kind === "inline" && presentation.messageStyle === "phase"
							? rendered
							: `${rendered}  ${option.label}`;
					return context.selected ? theme.bold(preview) : preview;
				}
				const cadenceMs =
					configuredAnimationCadenceMs(indicatorStyle, textEffectStyle, smoothness, speed, pulseEffectStyle) ??
					animationSmoothnessCadenceMs(smoothness);
				const elapsedMs = smoothnessField ? Math.floor((now - startedAt) / cadenceMs) * cadenceMs : now - startedAt;
				const frame = activityFrame(colors, textEffectField ? "Working..." : option.label, elapsedMs, {
					indicatorStyle,
					textEffectStyle,
					pulseEffectStyle,
					textEffectScope: appearance.textEffectScope,
					animationSpeed: speed,
					textTone: context.selected ? "accent" : "text.primary",
				});
				const animated = frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
				const preview = textEffectField ? `${animated}  ${option.label}` : animated;
				return context.selected ? theme.bold(preview) : preview;
			},
		});
		const previewCadences = options
			.map((option) => {
				const {
					indicatorStyle,
					messageStyle,
					presentationStyle,
					pulseEffectStyle,
					textEffectStyle,
					smoothness,
					speed,
				} = previewOptions(option.value);
				if (messageField || presentationField)
					return activityPresentationCadenceMs(
						resolveActivityPresentation(
							indicatorStyle,
							messageStyle,
							textEffectStyle,
							appearance.textEffectScope,
							pulseEffectStyle,
							presentationStyle,
						),
						smoothness,
						speed,
					);
				return configuredAnimationCadenceMs(indicatorStyle, textEffectStyle, smoothness, speed, pulseEffectStyle);
			})
			.filter((cadence): cadence is number => cadence !== undefined);
		const cadenceMs = previewCadences.length > 0 ? Math.min(...previewCadences) : undefined;
		if (cadenceMs !== undefined) {
			this.motion = sharedMotionScheduler.mount(
				{ requestRender },
				{
					cadenceMs,
					onFrame: (next) => {
						now = next;
					},
				},
			);
		}
	}

	dispose(): void {
		this.motion?.dispose();
	}
}

class EditorCompositionSelect extends SelectBox<string> {
	private readonly motion: MotionMount;

	constructor(
		field: EnumSettingField,
		theme: Theme,
		done: (value?: string) => void,
		preview: (value: string) => void,
		requestRender: () => void,
	) {
		let now = performance.now();
		const startedAt = now;
		const options = field.options.filter((option) => option.preview !== undefined);
		super({
			theme,
			title: field.label,
			bordered: false,
			showHint: true,
			options,
			selected: options.some((option) => option.value === field.value) ? field.value : undefined,
			onSelect: done,
			onPreview: preview,
			onCancel: () => done(),
			requestRender,
			renderOption: (option, context) => {
				const label = context.highlight(option.label);
				return context.selected ? theme.bold(label) : label;
			},
			renderPreview: (option, width) => {
				const preview = options.find((candidate) => candidate.value === option.value)?.preview;
				return preview ? renderEditorCompositionPreview(theme, preview, width, now - startedAt) : [];
			},
		});
		this.motion = sharedMotionScheduler.mount(
			{ requestRender },
			{
				cadenceMs: animationSmoothnessCadenceMs(getTuiAppearance().animationSmoothness),
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

export class SettingsEditor extends ComponentStack {
	private fields: SettingField[];
	private filtered: SettingField[];
	private selectedIndex = 0;
	private activeEditor: EditorComponent | undefined;
	private closeActiveEditor: (() => void) | undefined;
	private floatingEditor: FloatingOverlay | undefined;
	private replaceBaseEditor = false;
	private readonly baseView = new ComponentStack([]);
	private readonly list: SelectableList<SettingField>;
	private readonly emptyView = new RenderLines(() => [this.colors().fg("text.muted", "No matching settings")]);

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
		private readonly parentLabel?: string,
		private readonly onPreview?: (id: string, value: SettingValue) => void,
	) {
		super([], { height: maxVisible, anchorLastChild: true });
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
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.list.handleInput(data);
			return true;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.list.handleInput(data);
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
		this.list.setSelectedIndex(this.selectedIndex);
		this.list.setMaxVisible(Math.max(1, this.maxVisibleRows() - (this.parentLabel ? 2 : 0)));
		const content = this.filtered.length > 0 ? this.list : this.emptyView;
		const parentLabel = this.parentLabel;
		const children: Component[] = parentLabel
			? [
					new RenderLines(() => [
						this.theme.bold(this.colors().fg("heading", parentLabel)),
						this.colors().fg("border", "─".repeat(Math.max(1, width))),
					]),
					content,
				]
			: [content];
		this.baseView.setChildren(children);
		this.baseView.setActiveChild(content);
		if (this.replaceBaseEditor) this.activeEditor?.setMaxHeight?.(this.maxVisibleRows());
		const rendered = this.replaceBaseEditor
			? (this.activeEditor ?? this.baseView)
			: this.activeEditor && this.floatingEditor
				? this.floatingEditor
				: this.baseView;
		this.setChildren([rendered]);
		this.setActiveChild(rendered);
		return super.render(width);
	}

	setFields(fields: readonly SettingField[]): void {
		const selectedId = this.filtered[this.selectedIndex]?.id;
		this.fields = groupFieldsBySection(fields);
		this.filtered = [...this.fields];
		const retained = selectedId ? this.filtered.findIndex((field) => field.id === selectedId) : -1;
		this.selectedIndex = retained >= 0 ? retained : 0;
		this.list.setItems(this.filtered, this.selectedIndex);
	}

	getSelectedFieldId(): string | undefined {
		return this.filtered[this.selectedIndex]?.id;
	}

	selectField(id: string): boolean {
		const index = this.filtered.findIndex((field) => field.id === id);
		if (index < 0) return false;
		this.selectedIndex = index;
		this.list.setSelectedIndex(index);
		return true;
	}

	private renderField(field: SettingField, context: SelectableListRenderContext): SelectableListRow {
		const section = field.section ?? "General";
		const previousSection = this.filtered[context.index - 1]?.section ?? (context.index > 0 ? "General" : undefined);
		const startsSection = context.index === 0 || previousSection !== section;
		const colors = this.colors();
		const width = Math.max(1, context.width);
		const valueText = formatSettingValue(field);
		const optionColor =
			field.type === "enum" ? field.options.find((option) => option.value === field.value)?.color : undefined;
		const valueColor = optionColor ?? (isDefault(field) ? "text.secondary" : "heading");
		const surface = context.selected ? "surface.selected" : undefined;
		const before: string[] = [];
		if (startsSection) {
			if (context.index > 0) {
				before.push(
					context.previousSelected ? halfBlockSurfaceEdge(this.theme, "surface.selected", "bottom", width) : "",
				);
			}
			before.push(this.theme.bold(colors.fg("heading", section)));
			before.push(
				surface ? halfBlockSurfaceEdge(this.theme, surface, "top", width) : colors.fg("border", "─".repeat(width)),
			);
		} else {
			before.push(
				surface
					? halfBlockSurfaceEdge(this.theme, surface, "top", width)
					: context.previousSelected
						? halfBlockSurfaceEdge(this.theme, "surface.selected", "bottom", width)
						: colors.fg("border", "─".repeat(width)),
			);
		}

		const powerlineControl = getTuiAppearance().powerlineButtons;
		const selectSuffix = field.type === "enum" ? " ⯆" : "";
		const controlWidth = Math.min(
			Math.max(4, visibleWidth(valueText) + visibleWidth(selectSuffix) + 2 + (powerlineControl ? 2 : 0)),
			Math.max(4, Math.floor(width * 0.42)),
		);
		const controlBodyWidth = Math.max(1, controlWidth - (powerlineControl ? 2 : 0));
		const leftWidth = width - controlWidth - 4;
		const stacked = leftWidth < 22;
		const labelTone = context.selected ? "accent" : "text.primary";
		const cursor = "  ";
		const clippedValue = truncateToWidth(
			valueText,
			Math.max(1, controlBodyWidth - visibleWidth(selectSuffix) - 1),
			"…",
		);
		const controlLabel =
			field.type === "enum"
				? ` ${clippedValue}${selectSuffix} `
				: ` ${clippedValue}${" ".repeat(Math.max(1, controlBodyWidth - visibleWidth(clippedValue) - 1))}`;
		const controlBackground = context.hovered ? "surface.hover" : "surface.raised";
		const renderedValue = powerlineControl
			? renderPill(
					this.theme,
					{ icon: false, label: controlLabel },
					controlBackground,
					valueColor,
					undefined,
					undefined,
					true,
				)
			: colors.bg(controlBackground, colors.fg(valueColor, controlLabel));
		const labelWidth = stacked ? Math.max(1, width - 2) : Math.max(1, leftWidth - 2);
		const label = this.theme.bold(colors.fg(labelTone, truncateToWidth(field.label, labelWidth, "…")));
		const title = stacked
			? `${cursor}${label}`
			: `${cursor}${label}${" ".repeat(Math.max(1, leftWidth - visibleWidth(label) - 1))}${renderedValue}`;
		const descriptionWidth = stacked ? Math.max(1, width - 2) : Math.max(1, leftWidth - 2);
		const descriptionTone = surface ? colors.contrastBackground(colors.color(surface)) : "text.muted";
		const descriptions = new Text(colors.fg(descriptionTone, field.description), 0, 0)
			.render(descriptionWidth)
			.map((line) => `  ${line}`);
		const rows = stacked ? [title, ...descriptions, `  ${renderedValue}`] : [title, ...descriptions];
		const controlX = stacked ? visibleWidth(cursor) : Math.max(0, visibleWidth(title) - visibleWidth(renderedValue));
		const controlY = stacked ? 1 + descriptions.length : 0;
		const paddedRows = rows.map((line) => {
			const clipped = truncateToWidth(line, width, "");
			return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		});
		const rendered = surface
			? new BackgroundSurface({
					theme: this.theme,
					component: new RenderLines(() => paddedRows),
					background: surface,
				}).render(width)
			: paddedRows;
		return {
			before,
			content: rendered,
			target: { x: controlX, y: controlY, width: visibleWidth(renderedValue), height: 1 },
		};
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
			this.openEditor(editor, {
				width: settingDialogWidth(field),
				maxHeight: SETTINGS_DIALOG_MAX_HEIGHT,
				title: field.label,
				parent: this.getSelectedDialogAnchor(),
			});
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
			this.openEditor(editor, {
				width: settingDialogWidth(field),
				maxHeight: SETTINGS_DIALOG_MAX_HEIGHT,
				title: field.label,
				parent: this.getSelectedDialogAnchor(),
			});
			return;
		}
		if (field.type === "boolean") {
			this.apply(field.id, !field.value);
			return;
		}
		let previewed = false;
		const preview = (value: string): void => {
			if (!this.onPreview) return;
			previewed = true;
			this.onPreview(field.id, value);
		};
		const done = (value?: string): void => {
			if (value !== undefined) this.apply(field.id, value);
			else if (previewed) this.onPreview?.(field.id, field.value);
			this.closeEditor();
		};
		if (field.type === "enum") {
			if (field.preview === "editor-composition") {
				this.openReplacementEditor(new EditorCompositionSelect(field, this.theme, done, preview, this.requestRender));
				return;
			}
			const editor =
				field.preview !== undefined
					? new AnimationSelect(field, this.theme, done, preview, this.requestRender)
					: new SelectBox({
							theme: this.theme,
							bordered: false,
							options: field.options,
							selected: field.value,
							onSelect: done,
							onPreview: preview,
							onCancel: () => done(),
							requestRender: this.requestRender,
							renderOption: (option, context) => {
								const color = field.options.find((candidate) => candidate.value === option.value)?.color;
								const label = context.query
									? context.highlight(option.label)
									: color
										? tuiTheme(context.theme).fg(color, option.label)
										: option.label;
								return context.selected ? context.theme.bold(label) : label;
							},
						});
			this.openSelectBox(
				editor,
				field.options.map((option) => option.label),
				field.preview === undefined ? undefined : settingDialogWidth(field),
				() => done(),
			);
		} else if (field.type === "string") {
			this.openEditor(new StringEditor(field, this.theme, done, !this.dialogHost), {
				width: settingDialogWidth(field),
				maxHeight: SETTINGS_DIALOG_MAX_HEIGHT,
				title: field.label,
				parent: this.getSelectedDialogAnchor(),
			});
		} else {
			const toolOptions =
				field.category === "tools"
					? field.options.map((option) => ({ ...option, description: toolOptionSummary(option.description) }))
					: field.options;
			let previewedValues = false;
			const cancel = () => {
				if (previewedValues) this.onPreview?.(field.id, field.value);
				this.closeEditor();
			};
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
				onChange: (value) => {
					previewedValues = true;
					this.onPreview?.(field.id, value);
				},
				onCancel: cancel,
				confirmDiscard: false,
			});
			this.openEditor(editor, {
				width: settingDialogWidth(field),
				maxHeight: SETTINGS_DIALOG_MAX_HEIGHT,
				title: field.label,
				parent: this.getSelectedDialogAnchor(),
			});
		}
	}

	private getSelectedDialogAnchor(): DialogOverlayAnchor | undefined {
		const geometry = this.list.getGeometry();
		const item = geometry?.items.find((candidate) => candidate.index === this.selectedIndex);
		const span =
			this.baseView.getSpans().find((candidate) => candidate.component === this.list) ??
			this.getSpans().find((candidate) => candidate.component === this.list);
		if (!item || !span) return undefined;
		return {
			row: span.row + item.y,
			col: item.x + Math.min(32, Math.max(0, item.width - 1)),
		};
	}

	private openEditor(editor: EditorComponent, options: DialogOverlayOptions): void {
		this.activeEditor = editor;
		this.replaceBaseEditor = false;
		this.closeActiveEditor = this.dialogHost?.open(editor, options);
		if (!this.dialogHost) {
			const field = this.filtered[this.selectedIndex];
			const width = typeof options.width === "number" ? options.width : field ? settingDialogWidth(field) : 48;
			this.floatingEditor = new FloatingOverlay({
				base: this.baseView,
				overlay: new DialogOverlay(this.theme, editor, options.title),
				overlayWidth: (available) => Math.min(available, width),
				align: "end",
				top: () => this.getSelectedDialogAnchor()?.row ?? 0,
				maxHeight: () => this.maxVisibleRows(),
				surface: { theme: this.theme, background: "surface.raised" },
			});
		}
		this.requestRender();
	}

	private openSelectBox(
		editor: EditorComponent,
		labels: readonly string[],
		preferredWidth: number | undefined,
		onOutsidePress: () => void,
	): void {
		this.activeEditor = editor;
		this.replaceBaseEditor = false;
		const width = preferredWidth ?? Math.min(48, Math.max(16, ...labels.map((label) => visibleWidth(label) + 6)));
		this.floatingEditor = new FloatingOverlay({
			base: this.baseView,
			overlay: editor,
			overlayWidth: (available) => Math.min(available, width),
			align: "end",
			top: () => this.getSelectedDialogAnchor()?.row ?? 0,
			maxHeight: () => this.maxVisibleRows(),
			surface: { theme: this.theme, background: "surface.raised" },
			onOutsidePress,
		});
		this.requestRender();
	}

	private openReplacementEditor(editor: EditorComponent): void {
		this.activeEditor = editor;
		this.replaceBaseEditor = true;
		this.requestRender();
	}

	private closeEditor(): void {
		const close = this.closeActiveEditor;
		this.activeEditor?.dispose?.();
		this.closeActiveEditor = undefined;
		this.activeEditor = undefined;
		this.floatingEditor = undefined;
		this.replaceBaseEditor = false;
		close?.();
		this.requestRender();
	}

	dispose(): void {
		this.closeEditor();
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
		if (!field?.configured) return;
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
