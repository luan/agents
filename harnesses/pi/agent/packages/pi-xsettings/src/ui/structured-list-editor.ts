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
	ComponentStack,
	DialogButtonBar,
	type DialogHost,
	type DialogOverlayOptions,
	icon,
	SearchableSelect,
	SelectableList,
	type SelectableListRenderContext,
	SemanticInput,
	tuiTheme,
} from "pi-libtui";
import type { TSchema } from "typebox";
import { checkSchema } from "../config/schema.ts";
import type { ListDefinition, ListItemField, SettingOption, SettingValue } from "../protocol/settings.ts";
import { RenderLines } from "./fields.ts";

type SettingObject = { [key: string]: SettingValue };
type Path = Array<number | string>;

interface ListFrame {
	kind: "list";
	definition: ListDefinition;
	path: Path;
	selected: number;
}

interface ItemFrame {
	kind: "item";
	definition: ListDefinition;
	path: Path;
	selected: number;
}

type Frame = ListFrame | ItemFrame;
type EditorAction = "add" | "delete" | "move-up" | "move-down" | "save" | "back" | "cancel";

class InlineStringEditor extends ComponentStack {
	private readonly input: SemanticInput;

	constructor(
		label: string,
		description: string,
		value: string,
		theme: Theme,
		done: (value?: string) => void,
		showTitle = true,
	) {
		const colors = tuiTheme(theme);
		const input = new SemanticInput(theme);
		input.setValue(value);
		input.onSubmit = done;
		input.onEscape = () => done();
		const buttons = new DialogButtonBar({
			theme,
			leading: () => colors.fg("text.muted", "Enter save · Esc cancel"),
			buttons: [
				{
					value: "cancel",
					label: "Cancel",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
				},
				{
					value: "save",
					label: "Save",
					icon: "confirm",
					foreground: "positive",
					background: "action.positive",
				},
			],
			requestRender() {},
			onActivate: (action) => (action === "save" ? done(input.getValue()) : done()),
		});
		const children: Component[] = [
			new Text(colors.fg("text.muted", description), 0, 0),
			new Spacer(1),
			input,
			new Spacer(1),
			buttons,
		];
		if (showTitle) children.unshift(new Text(theme.bold(colors.fg("accent", label)), 0, 0));
		super(children, { activeChild: showTitle ? 3 : 2 });
		this.input = input;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

export interface StructuredListEditorOptions {
	label: string;
	description: string;
	value: SettingValue[];
	schema: TSchema;
	list: ListDefinition;
	modelOptions: readonly SettingOption[];
	theme: Theme;
	onSave(value: SettingValue[]): void;
	onCancel(): void;
	dialogHost?: DialogHost;
	showTitle?: boolean;
}

export class StructuredListEditor extends ComponentStack {
	private draft: SettingValue[];
	private readonly initial: string;
	private readonly frames: Frame[];
	private activeEditor: Component | undefined;
	private closeActiveEditor: (() => void) | undefined;
	private discardPending = false;
	private deletePending = false;
	private status = "";
	private activeList:
		| (Component & {
				handleInput(data: string): boolean;
				setSelectedIndex(index: number): void;
		  })
		| undefined;

	constructor(private readonly editorOptions: StructuredListEditorOptions) {
		super();
		this.draft = cloneValue(editorOptions.value);
		this.initial = JSON.stringify(editorOptions.value);
		this.frames = [{ kind: "list", definition: editorOptions.list, path: [], selected: 0 }];
		this.refreshLayout();
	}

	private colors() {
		return tuiTheme(this.editorOptions.theme);
	}

	handleInput(data: string): void {
		if (this.activeEditor) {
			this.activeEditor.handleInput?.(data);
			return;
		}
		const frame = this.frame();
		const keys = getKeybindings();
		if (matchesKey(data, "ctrl+s")) {
			this.save();
			return;
		}
		if (keys.matches(data, "tui.select.cancel") || data === "q") {
			this.backOrCancel();
			return;
		}
		this.discardPending = false;
		this.status = "";
		if (data === "j" || keys.matches(data, "tui.select.down")) this.activeList?.handleInput(data);
		else if (data === "k" || keys.matches(data, "tui.select.up")) this.activeList?.handleInput(data);
		else if (matchesKey(data, "home")) this.select(0);
		else if (data === "G" || matchesKey(data, "end")) this.select(this.rowCount(frame) - 1);
		else if (keys.matches(data, "tui.select.confirm")) this.activeList?.handleInput(data);
		else if (frame.kind === "list") this.handleListInput(frame, data);
		else this.handleItemInput(frame, data);
	}

	invalidate(): void {
		super.invalidate();
	}

	private frame(): Frame {
		return this.frames.at(-1)!;
	}
	private dirty(): boolean {
		return JSON.stringify(this.draft) !== this.initial;
	}
	private rowCount(frame: Frame): number {
		return frame.kind === "list" ? this.listAt(frame.path).length : frame.definition.fields.length;
	}
	private select(index: number): void {
		const frame = this.frame();
		const count = this.rowCount(frame);
		frame.selected = Math.max(0, Math.min(Math.max(0, count - 1), index));
		this.activeList?.setSelectedIndex(frame.selected);
	}

	private handleListInput(frame: ListFrame, data: string): void {
		const shortcut = frame.definition.fields.findIndex((field) => field.shortcut === data);
		if (shortcut >= 0) this.openSelectedField(frame, shortcut);
		else if (matchesKey(data, "ctrl+j")) this.reorder(frame, 1);
		else if (matchesKey(data, "ctrl+k")) this.reorder(frame, -1);
		else if (data === "a") this.add(frame);
		else if (data === "d") {
			if (this.deletePending) this.remove(frame);
			else {
				this.deletePending = true;
				this.status = "Press d again to delete.";
			}
		}
	}

	private handleItemInput(frame: ItemFrame, data: string): void {
		const shortcut = frame.definition.fields.findIndex((field) => field.shortcut === data);
		if (shortcut >= 0) frame.selected = shortcut;
		else if (data !== " ") return;
		this.activateItemField(frame);
	}

	private openSelectedField(frame: ListFrame, fieldIndex: number): void {
		const list = this.listAt(frame.path);
		if (!list[frame.selected]) return;
		const itemFrame: ItemFrame = {
			kind: "item",
			definition: frame.definition,
			path: [...frame.path, frame.selected],
			selected: fieldIndex,
		};
		this.frames.push(itemFrame);
		this.activateItemField(itemFrame);
		if (!this.activeEditor) this.refreshLayout();
	}

	private activateItemField(frame: ItemFrame): void {
		const field = frame.definition.fields[frame.selected];
		if (!field) return;
		const item = this.objectAt(frame.path);
		if (field.type === "boolean") {
			item[field.key] = item[field.key] !== true;
			this.refreshLayout();
			return;
		}
		if (field.type === "list") {
			this.frames.push({
				kind: "list",
				definition: field.list,
				path: [...frame.path, field.key],
				selected: 0,
			});
			this.refreshLayout();
			return;
		}
		const done = (value?: string): void => {
			if (value !== undefined) item[field.key] = value;
			this.closeEditor();
		};
		if (field.type === "string") {
			const current = item[field.key];
			this.openEditor(
				new InlineStringEditor(
					field.label,
					field.description,
					typeof current === "string" ? current : "",
					this.editorOptions.theme,
					done,
					!this.editorOptions.dialogHost,
				),
				{ title: field.label, width: "60%", maxHeight: "70%" },
			);
			return;
		}
		const options = Array.isArray(field.options) ? field.options : this.editorOptions.modelOptions;
		const current = item[field.key];
		const editor = new SearchableSelect({
			title: field.label,
			showTitle: false,
			description: field.description,
			options: options.map((option) => ({
				...option,
				value: String(option.value),
				label: option.color ? this.colors().fg(option.color, option.label) : option.label,
			})),
			selected: typeof current === "string" ? current : undefined,
			theme: this.editorOptions.theme,
			onSelect: done,
			onCancel: () => done(),
		});
		this.openEditor(editor, {
			title: field.label,
			width: "65%",
			maxHeight: "85%",
		});
	}

	private openEditor(editor: Component, options: DialogOverlayOptions): void {
		this.activeEditor = editor;
		this.closeActiveEditor = this.editorOptions.dialogHost?.open(editor, options);
		this.refreshLayout();
	}

	private closeEditor(): void {
		const close = this.closeActiveEditor;
		this.closeActiveEditor = undefined;
		this.activeEditor = undefined;
		close?.();
		this.refreshLayout();
	}

	private reorder(frame: ListFrame, delta: number): void {
		const list = this.listAt(frame.path);
		const next = Math.max(0, Math.min(list.length - 1, frame.selected + delta));
		if (next === frame.selected) return;
		const [item] = list.splice(frame.selected, 1);
		list.splice(next, 0, item!);
		frame.selected = next;
		this.refreshLayout();
	}

	private add(frame: ListFrame): void {
		const list = this.listAt(frame.path);
		const item = cloneValue(frame.definition.newItem);
		const identity = item[frame.definition.identity];
		if (frame.definition.uniqueIdentity && typeof identity === "string") {
			const used = new Set(
				list.flatMap((entry) => {
					const value = asObject(entry)?.[frame.definition.identity];
					return typeof value === "string" ? [value] : [];
				}),
			);
			let candidate = identity;
			let suffix = 2;
			while (used.has(candidate)) candidate = `${identity}-${suffix++}`;
			item[frame.definition.identity] = candidate;
		}
		list.push(item);
		frame.selected = list.length - 1;
		this.frames.push({
			kind: "item",
			definition: frame.definition,
			path: [...frame.path, frame.selected],
			selected: 0,
		});
		this.refreshLayout();
	}

	private remove(frame: ListFrame): void {
		const list = this.listAt(frame.path);
		this.deletePending = false;
		if (list.length <= frame.definition.minItems) {
			this.status = `Keep at least ${frame.definition.minItems} ${frame.definition.itemLabel}${frame.definition.minItems === 1 ? "" : "s"}.`;
			return;
		}
		list.splice(frame.selected, 1);
		frame.selected = Math.min(frame.selected, list.length - 1);
		this.status = "";
		this.refreshLayout();
	}

	private save(): void {
		if (!validList(this.draft, this.editorOptions.list) || !checkSchema(this.editorOptions.schema, this.draft)) {
			this.status = "Some list values are invalid. Fix them before saving.";
			return;
		}
		this.editorOptions.onSave(cloneValue(this.draft));
	}

	private backOrCancel(): void {
		if (this.frames.length > 1) {
			this.frames.pop();
			this.deletePending = false;
			this.discardPending = false;
			this.status = "";
			this.refreshLayout();
			return;
		}
		this.cancelDraft();
	}

	private cancelDraft(): void {
		if (!this.dirty() || this.discardPending) this.editorOptions.onCancel();
		else {
			this.discardPending = true;
			this.status = "Unsaved changes. Press Esc/q again to discard.";
		}
	}

	private activateListItem(frame: ListFrame, index: number): void {
		this.deletePending = false;
		const list = this.listAt(frame.path);
		if (!list[index]) return;
		frame.selected = index;
		this.frames.push({
			kind: "item",
			definition: frame.definition,
			path: [...frame.path, index],
			selected: 0,
		});
		this.refreshLayout();
	}

	private performAction(action: EditorAction): void {
		if (action !== "cancel") {
			this.discardPending = false;
			this.deletePending = false;
			this.status = "";
		}
		const frame = this.frame();
		if (action === "save") this.save();
		else if (action === "cancel") this.cancelDraft();
		else if (action === "back") this.backOrCancel();
		else if (frame.kind === "list" && action === "add") this.add(frame);
		else if (frame.kind === "list" && action === "delete") this.remove(frame);
		else if (frame.kind === "list" && action === "move-up") this.reorder(frame, -1);
		else if (frame.kind === "list" && action === "move-down") this.reorder(frame, 1);
	}

	private refreshLayout(): void {
		if (this.activeEditor && !this.editorOptions.dialogHost) {
			this.activeList = undefined;
			this.setChildren([this.activeEditor]);
			this.setActiveChild(this.activeEditor);
			return;
		}

		const frame = this.frame();
		const header = new RenderLines(() =>
			frame.kind === "list" ? this.renderListHeader(frame) : this.renderItemHeader(frame),
		);
		if (frame.kind === "list") {
			const items = this.listAt(frame.path);
			this.activeList = new SelectableList({
				items,
				selectedIndex: frame.selected,
				maxVisible: 10,
				wrap: false,
				renderItem: (item, context) => this.renderListRow(frame.definition, item, context),
				requestRender() {},
				onSelectionChange: (_item, index) => {
					frame.selected = index;
				},
				onActivate: (_item, index) => this.activateListItem(frame, index),
			});
		} else {
			this.activeList = new SelectableList({
				items: frame.definition.fields,
				selectedIndex: frame.selected,
				wrap: false,
				renderItem: (field, context) => this.renderItemRow(frame, field, context),
				requestRender() {},
				onSelectionChange: (_field, index) => {
					frame.selected = index;
				},
				onActivate: (_field, index) => {
					frame.selected = index;
					this.activateItemField(frame);
				},
			});
		}

		const details = new RenderLines((width) => {
			if (frame.kind !== "item") return [];
			const selected = frame.definition.fields[frame.selected];
			return selected ? ["", this.colors().fg("text.muted", truncateToWidth(selected.description, width, ""))] : [];
		});
		const footer = new RenderLines(() => ["", this.renderStatus()]);
		const buttons = new DialogButtonBar<EditorAction>({
			theme: this.editorOptions.theme,
			leading: () =>
				this.colors().fg(
					"text.muted",
					`${frame.kind === "list" ? "↑↓ move · Enter fields" : "↑↓ move · Enter edit"}${this.shortcutHint(frame.definition)}`,
				),
			buttons:
				frame.kind === "list"
					? [
							{
								value: "add",
								label: "Add",
								foreground: "positive",
								background: "action.positive",
								align: "start",
							},
							{
								value: "delete",
								label: "Delete",
								foreground: "negative",
								background: "action.negative",
								align: "start",
							},
							{
								value: "move-up",
								label: "Move Up",
								foreground: "text.primary",
								background: "action.neutral",
								align: "start",
							},
							{
								value: "move-down",
								label: "Move Down",
								foreground: "text.primary",
								background: "action.neutral",
								align: "start",
							},
							...(this.frames.length > 1
								? [
										{
											value: "back" as const,
											label: "Back",
											foreground: "text.primary" as const,
											background: "action.neutral" as const,
											align: "end" as const,
										},
									]
								: []),
							{
								value: "cancel",
								label: "Cancel",
								icon: "cancel",
								foreground: "text.primary",
								background: "action.neutral",
								align: "end",
							},
							{
								value: "save",
								label: "Save",
								icon: "confirm",
								foreground: "positive",
								background: "action.positive",
								align: "end",
							},
						]
					: [
							{
								value: "back",
								label: "Back",
								foreground: "text.primary",
								background: "action.neutral",
								align: "start",
							},
							{
								value: "cancel",
								label: "Cancel",
								icon: "cancel",
								foreground: "text.primary",
								background: "action.neutral",
								align: "end",
							},
							{
								value: "save",
								label: "Save",
								icon: "confirm",
								foreground: "positive",
								background: "action.positive",
								align: "end",
							},
						],
			requestRender() {},
			onActivate: (action) => this.performAction(action),
		});
		this.setChildren([header, this.activeList, details, footer, buttons]);
		this.setActiveChild(this.activeList);
	}

	private renderListHeader(frame: ListFrame): string[] {
		const list = this.listAt(frame.path);
		const title = this.frames.length === 1 ? this.editorOptions.label : `${frame.definition.itemLabel}s`;
		const description =
			this.frames.length === 1
				? this.editorOptions.description
				: `Ordered ${frame.definition.itemLabel.toLowerCase()} list.`;
		return [
			...(this.frames.length === 1 && this.editorOptions.showTitle === false
				? []
				: [this.editorOptions.theme.bold(this.colors().fg("accent", title))]),
			this.colors().fg("text.muted", description),
			"",
			...(list.length === 0
				? [this.colors().fg("text.muted", `No ${frame.definition.itemLabel.toLowerCase()}s.`)]
				: []),
		];
	}

	private renderItemHeader(frame: ItemFrame): string[] {
		const item = this.objectAt(frame.path);
		const identity = item[frame.definition.identity];
		return [
			this.editorOptions.theme.bold(
				this.colors().fg("accent", `${frame.definition.itemLabel}: ${String(identity ?? "")}`),
			),
			this.colors().fg("text.muted", "Edit fields, then press Esc to return to the list."),
			"",
		];
	}

	private renderListRow(definition: ListDefinition, value: SettingValue, context: SelectableListRenderContext): string {
		const { index, selected, hovered, width } = context;
		const item = asObject(value) ?? {};
		const rawIdentity = String(item[definition.identity] ?? `${definition.itemLabel} ${index + 1}`);
		const identityColorValue = definition.identityColor ? valueAt(item, definition.identityColor.path) : undefined;
		const identityColor =
			typeof identityColorValue === "string" ? definition.identityColor?.colors[identityColorValue] : undefined;
		const identity = identityColor
			? this.colors().fg(identityColor, this.editorOptions.theme.bold(rawIdentity))
			: this.editorOptions.theme.bold(rawIdentity);
		const details = definition.summary
			.flatMap((column) => {
				const raw = valueAt(item, column.path);
				const text = scalarSummary(raw);
				if (!text) return [];
				const color = column.color ?? (typeof raw === "string" ? column.colors?.[raw] : undefined);
				return [color ? this.colors().fg(color, text) : text];
			})
			.join("  ");
		const row = truncateToWidth(` ${index + 1}. ${identity}${details ? `  ${details}` : ""}`, width, "");
		const padded = row + " ".repeat(Math.max(0, width - visibleWidth(row)));
		return selected || hovered ? this.colors().bg("surface.selected", padded) : padded;
	}

	private renderItemRow(frame: ItemFrame, field: ListItemField, context: SelectableListRenderContext): string {
		const item = this.objectAt(frame.path);
		const labelWidth = Math.min(
			28,
			Math.max(...frame.definition.fields.map((candidate) => visibleWidth(candidate.label))) + 2,
		);
		const label = `${context.selected ? this.colors().fg("accent", "› ") : "  "}${field.label}`;
		const padded = label + " ".repeat(Math.max(1, labelWidth - visibleWidth(label)));
		const value = this.formatField(field, item[field.key]);
		const row = truncateToWidth(
			`${padded}${context.selected ? this.colors().fg("accent", value) : this.colors().fg("text.muted", value)}`,
			context.width,
			"",
		);
		const filled = row + " ".repeat(Math.max(0, context.width - visibleWidth(row)));
		return context.selected || context.hovered ? this.colors().bg("surface.selected", filled) : filled;
	}

	private renderStatus(): string {
		return this.colors().fg(this.discardPending || this.deletePending ? "warning" : "text.muted", this.status);
	}

	private formatField(field: ListItemField, value: SettingValue | undefined): string {
		if (field.type === "boolean")
			return `${icon(value === true ? "toggle-on" : "toggle-off")} ${value === true ? "on" : "off"}`;
		if (field.type === "list")
			return `${Array.isArray(value) ? value.length : 0} ${field.list.itemLabel.toLowerCase()}${Array.isArray(value) && value.length === 1 ? "" : "s"}`;
		if (field.type === "enum") {
			const options = Array.isArray(field.options) ? field.options : this.editorOptions.modelOptions;
			const option = options.find((candidate) => candidate.value === value);
			const label = option?.label ?? String(value ?? "unset");
			return option?.color ? this.colors().fg(option.color, label) : label;
		}
		return String(value ?? "unset");
	}

	private shortcutHint(definition: ListDefinition): string {
		const shortcuts = definition.fields.flatMap((field) =>
			field.shortcut ? [`${field.shortcut} ${field.label.toLowerCase()}`] : [],
		);
		return shortcuts.length > 0 ? ` · ${shortcuts.join(" · ")}` : "";
	}

	private listAt(path: Path): SettingValue[] {
		const value = this.valueAt(path);
		if (!Array.isArray(value)) throw new Error(`Expected a list at ${path.join(".") || "root"}.`);
		return value;
	}

	private objectAt(path: Path): SettingObject {
		const value = this.valueAt(path);
		const object = asObject(value);
		if (!object) throw new Error(`Expected an item at ${path.join(".")}.`);
		return object;
	}

	private valueAt(path: Path): SettingValue {
		let value: SettingValue = this.draft;
		for (const segment of path) {
			if (typeof segment === "number") {
				if (!Array.isArray(value)) throw new Error(`Expected a list before ${segment}.`);
				value = value[segment]!;
			} else {
				const object = asObject(value);
				if (!object) throw new Error(`Expected an item before ${segment}.`);
				value = object[segment]!;
			}
		}
		return value;
	}
}

function asObject(value: SettingValue | undefined): SettingObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function scalarSummary(value: SettingValue | undefined): string | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `${value.length}`;
	return undefined;
}

function valueAt(value: SettingValue, path: readonly (number | string)[]): SettingValue | undefined {
	let current: SettingValue | undefined = value;
	for (const segment of path) {
		if (typeof segment === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[segment];
		} else {
			const object = asObject(current);
			if (!object) return undefined;
			current = object[segment];
		}
	}
	return current;
}

function validList(values: SettingValue[], definition: ListDefinition): boolean {
	if (values.length < definition.minItems) return false;
	const identities = values.map((value) => asObject(value)?.[definition.identity]);
	if (identities.some((value) => typeof value !== "string" || value.length === 0)) return false;
	if (definition.uniqueIdentity && new Set(identities).size !== identities.length) return false;
	return values.every((value) => {
		const item = asObject(value);
		if (!item) return false;
		return definition.fields.every((field) => {
			if (field.type !== "list") return true;
			const nested = item[field.key];
			return Array.isArray(nested) && validList(nested, field.list);
		});
	});
}

function cloneValue<Value extends SettingValue>(value: Value): Value {
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as Value;
	if (typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])) as Value;
	return value;
}
