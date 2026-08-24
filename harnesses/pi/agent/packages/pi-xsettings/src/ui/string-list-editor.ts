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
import { ComponentStack, DialogButtonBar, type DialogHost, SelectableList, SemanticInput, tuiTheme } from "pi-libtui";
import { RenderLines } from "./fields.ts";

class StringItemEditor extends ComponentStack {
	private readonly input: SemanticInput;

	constructor(label: string, value: string, theme: Theme, done: (value?: string) => void, showTitle = true) {
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
		const children: Component[] = [new Spacer(1), input, new Spacer(1), buttons];
		if (showTitle) children.unshift(new Text(theme.bold(colors.fg("accent", label)), 0, 0));
		super(children, { activeChild: showTitle ? 2 : 1 });
		this.input = input;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

export interface StringListEditorOptions {
	label: string;
	description: string;
	value: readonly string[];
	minItems: number;
	theme: Theme;
	onSave(value: string[]): void;
	onCancel(): void;
	dialogHost?: DialogHost;
	showTitle?: boolean;
}

type ListAction = "add" | "delete" | "move-up" | "move-down" | "save" | "cancel";

export class StringListEditor extends ComponentStack {
	private readonly draft: string[];
	private readonly initial: string;
	private readonly list: SelectableList<string>;
	private readonly listLayout: readonly Component[];
	private selected = 0;
	private activeEditor: StringItemEditor | undefined;
	private closeActiveEditor: (() => void) | undefined;
	private discardPending = false;
	private deletePending = false;
	private status = "";

	constructor(private readonly editorOptions: StringListEditorOptions) {
		super();
		this.draft = [...editorOptions.value];
		this.initial = JSON.stringify(editorOptions.value);
		this.list = new SelectableList({
			items: this.draft,
			selectedIndex: this.selected,
			maxVisible: 10,
			wrap: false,
			renderItem: (value, context) => {
				const row = truncateToWidth(` ${context.index + 1}. ${value}`, context.width, "");
				const padded = row + " ".repeat(Math.max(0, context.width - visibleWidth(row)));
				return context.selected || context.hovered ? this.colors().bg("surface.selected", padded) : padded;
			},
			requestRender() {},
			onSelectionChange: (_value, index) => {
				this.selected = index;
			},
			onActivate: (_value, index) => this.edit(index, this.draft[index]!),
		});
		const buttons = new DialogButtonBar<ListAction>({
			theme: editorOptions.theme,
			leading: () => this.colors().fg("text.muted", "↑↓ move · Enter edit"),
			buttons: [
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
			onActivate: (action) => this.activate(action),
		});
		this.listLayout = [
			new RenderLines(() => [
				...(this.editorOptions.showTitle === false
					? []
					: [this.editorOptions.theme.bold(this.colors().fg("accent", this.editorOptions.label))]),
				this.colors().fg("text.muted", this.editorOptions.description),
				"",
			]),
			this.list,
			new RenderLines(() => (this.draft.length === 0 ? [this.colors().fg("text.muted", "No items.")] : [])),
			new Spacer(1),
			new RenderLines(() => [
				this.colors().fg(this.discardPending || this.deletePending ? "warning" : "text.muted", this.status),
			]),
			buttons,
		];
		this.showList();
	}

	private colors() {
		return tuiTheme(this.editorOptions.theme);
	}

	handleInput(data: string): void {
		if (this.activeEditor) {
			this.activeEditor.handleInput(data);
			return;
		}
		const keys = getKeybindings();
		if (matchesKey(data, "ctrl+s")) {
			this.editorOptions.onSave([...this.draft]);
			return;
		}
		if (keys.matches(data, "tui.select.cancel") || data === "q") {
			this.cancel();
			return;
		}
		this.discardPending = false;
		this.status = "";
		if (data === "j" || keys.matches(data, "tui.select.down")) this.list.handleInput(data);
		else if (data === "k" || keys.matches(data, "tui.select.up")) this.list.handleInput(data);
		else if (matchesKey(data, "home")) this.select(0);
		else if (data === "G" || matchesKey(data, "end")) this.select(this.draft.length - 1);
		else if (matchesKey(data, "ctrl+j")) this.reorder(1);
		else if (matchesKey(data, "ctrl+k")) this.reorder(-1);
		else if (data === "a") this.edit(this.draft.length, "");
		else if (data === "d") {
			if (this.deletePending) this.remove();
			else {
				this.deletePending = true;
				this.status = "Press d again to delete.";
			}
		} else if (keys.matches(data, "tui.select.confirm")) {
			this.list.handleInput(data);
		}
	}

	private dirty(): boolean {
		return JSON.stringify(this.draft) !== this.initial;
	}
	private select(index: number): void {
		this.selected = Math.max(0, Math.min(Math.max(0, this.draft.length - 1), index));
		this.list.setSelectedIndex(this.selected);
	}

	private reorder(delta: number): void {
		if (this.draft.length === 0) return;
		const next = Math.max(0, Math.min(this.draft.length - 1, this.selected + delta));
		if (next === this.selected) return;
		const [item] = this.draft.splice(this.selected, 1);
		this.draft.splice(next, 0, item!);
		this.selected = next;
		this.syncList();
	}

	private edit(index: number, value: string): void {
		this.deletePending = false;
		const title = index === this.draft.length ? `Add ${this.editorOptions.label}` : `Edit ${this.editorOptions.label}`;
		const editor = new StringItemEditor(
			title,
			value,
			this.editorOptions.theme,
			(next) => {
				if (next !== undefined) {
					if (index === this.draft.length) this.draft.push(next);
					else this.draft[index] = next;
					this.selected = index;
					this.syncList();
				}
				this.closeEditor();
			},
			!this.editorOptions.dialogHost,
		);
		this.activeEditor = editor;
		if (this.editorOptions.dialogHost) {
			this.closeActiveEditor = this.editorOptions.dialogHost.open(editor, {
				title,
				width: "60%",
				maxHeight: "60%",
			});
		} else {
			this.setChildren([editor]);
			this.setActiveChild(editor);
		}
	}

	private closeEditor(): void {
		const close = this.closeActiveEditor;
		this.closeActiveEditor = undefined;
		this.activeEditor = undefined;
		close?.();
		this.showList();
	}

	private remove(): void {
		this.deletePending = false;
		if (this.draft.length <= this.editorOptions.minItems) {
			this.status = `Keep at least ${this.editorOptions.minItems} item${this.editorOptions.minItems === 1 ? "" : "s"}.`;
			return;
		}
		this.draft.splice(this.selected, 1);
		this.selected = Math.max(0, Math.min(this.selected, this.draft.length - 1));
		this.syncList();
	}

	private activate(action: ListAction): void {
		if (action !== "cancel") this.clearPending();
		if (action === "add") this.edit(this.draft.length, "");
		else if (action === "delete") this.remove();
		else if (action === "move-up") this.reorder(-1);
		else if (action === "move-down") this.reorder(1);
		else if (action === "save") this.editorOptions.onSave([...this.draft]);
		else this.cancel();
	}

	private cancel(): void {
		if (!this.dirty() || this.discardPending) this.editorOptions.onCancel();
		else {
			this.discardPending = true;
			this.status = "Unsaved changes. Press Esc/q or Cancel again to discard.";
		}
	}

	private clearPending(): void {
		this.discardPending = false;
		this.deletePending = false;
		this.status = "";
	}

	private syncList(): void {
		this.list.setItems(this.draft, this.selected);
	}
	private showList(): void {
		this.setChildren(this.listLayout);
		this.setActiveChild(this.list);
	}
}
