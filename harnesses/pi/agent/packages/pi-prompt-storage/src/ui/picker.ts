import { relative } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	type Component,
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	PickerPanel,
	type PickerOption,
	type PickerPanelHost,
	SelectableList,
	SemanticInput,
	type SelectableListRenderContext,
	tuiTheme,
} from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import {
	filterPrompts,
	preview,
	queryMatchIndexes,
	sourceLabel,
	type IndexProgress,
	type PromptAction,
	type PromptItem,
	type PromptKind,
	type PromptStorageConfig,
} from "../core/model.ts";

export interface PromptIndexView {
	progress(cwd: string): IndexProgress | undefined;
	watch(cwd: string, listener: (progress: IndexProgress | undefined) => void): () => void;
}

export interface PickerResult {
	item: PromptItem;
	action: PromptAction;
	selectionAfterDrop?: PromptItem["id"];
}

function dateLabel(timestamp: number): string {
	return new Date(timestamp).toLocaleString("en-GB", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function highlighted(text: string, query: string, theme: Theme, selected: boolean): string {
	const indexes = queryMatchIndexes(text, query);
	if (indexes.size === 0) return selected ? theme.bold(text) : text;
	let result = "";
	let start = 0;
	let active = indexes.has(0);
	for (let index = 1; index <= text.length; index++) {
		const next = index < text.length && indexes.has(index);
		if (next === active && index < text.length) continue;
		const part = text.slice(start, index);
		result += active ? tuiTheme(theme).fg("warning", theme.bold(part)) : part;
		start = index;
		active = next;
	}
	return selected ? theme.bold(result) : result;
}

function fitLine(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function promptSearchText(item: PromptItem): string {
	return [item.text, item.sessionName, item.cwd].filter(Boolean).join(" ");
}

function renderSharedPickerItem(item: PromptItem, theme: Theme): string {
	const colors = tuiTheme(theme);
	const cwd = relative(process.env.HOME ?? "", item.cwd) || item.cwd;
	const image = item.hasImages ? colors.fg("warning", " 🖼") : "";
	return [
		`${theme.bold(sourceLabel(item))}${image}`,
		colors.fg("text.muted", dateLabel(item.timestamp)),
		colors.fg("text.muted", cwd),
	]
		.filter(Boolean)
		.join("  ");
}

export function createStashPicker(
	tui: PickerPanelHost,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: PickerResult | null) => void,
	items: readonly PromptItem[],
	config: PromptStorageConfig,
	selected?: PromptItem["id"],
): PickerPanel<string> {
	const byValue = new Map<string, PromptItem>();
	const valueFor = (item: PromptItem): string => `${typeof item.id}:${item.id}`;
	const options: PickerOption<string>[] = items.map((item) => {
		const value = valueFor(item);
		byValue.set(value, item);
		return { value, label: sourceLabel(item), searchText: promptSearchText(item) };
	});
	const defaultAction = config.picker.enterAction;
	let action: PromptAction = defaultAction;
	const picker = new PickerPanel<string>({
		tui,
		theme,
		keybindings,
		title: "Prompt Stash",
		options,
		selected: selected === undefined ? undefined : `${typeof selected}:${selected}`,
		maxVisible: config.picker.maxVisible,
		emptyMessage: "No matching stashes.",
		confirmLabel: defaultAction === "pop" ? "Pop" : "Apply",
		navigationHint: "ctrl+a apply · ctrl+x drop",
		renderOption: (option, { theme: rowTheme }) => {
			const item = byValue.get(option.value);
			return item ? renderSharedPickerItem(item, rowTheme) : option.label;
		},
		onSelect: (value) => {
			const item = byValue.get(value);
			if (!item) return;
			const fallback = action === "drop" ? picker.getFallbackValueAfterRemoval() : undefined;
			done({ item, action, selectionAfterDrop: fallback === undefined ? undefined : byValue.get(fallback)?.id });
		},
		onCancel: () => done(null),
	});
	const handleInput = picker.handleInput.bind(picker);
	picker.handleInput = (data: string): void => {
		const nextAction = matchesKey(data, Key.ctrl("a")) ? "apply" : matchesKey(data, Key.ctrl("x")) ? "drop" : undefined;
		if (!nextAction) {
			handleInput(data);
			return;
		}
		action = nextAction;
		handleInput("\r");
		action = defaultAction;
	};
	return picker;
}

class PromptPicker implements Component, Focusable {
	private readonly input: SemanticInput;
	private readonly list: SelectableList<PromptItem>;
	private filtered: PromptItem[];
	private focusedValue = true;
	private progress?: string;
	private stopWatching?: () => void;
	private listStart = 0;
	private listHeight = 0;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: Theme,
		private readonly title: string,
		private readonly items: readonly PromptItem[],
		private readonly config: PromptStorageConfig,
		private readonly mode: PromptKind,
		private readonly done: (result: PickerResult | null) => void,
		index: PromptIndexView,
		cwd?: string,
	) {
		this.input = new SemanticInput(theme);
		this.filtered = filterPrompts(items, "", config.history.maxResults);
		if (cwd) {
			this.progress = this.progressLabel(index.progress(cwd));
			this.stopWatching = index.watch(cwd, (next) => {
				this.progress = this.progressLabel(next);
				this.applyFilter();
				this.tui.requestRender();
			});
		}
		this.list = new SelectableList({
			items: this.filtered,
			maxVisible: config.picker.maxVisible,
			activateOnClick: false,
			renderItem: (item, context) => this.renderItem(item, context),
			requestRender: () => this.tui.requestRender(),
			onActivate: (item) =>
				this.choose(this.mode === "stash" && config.picker.enterAction === "pop" ? "pop" : "apply", item),
		});
	}

	get focused(): boolean {
		return this.focusedValue;
	}
	set focused(value: boolean) {
		this.focusedValue = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(null);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) this.list.handleInput(Key.up);
		else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) this.list.handleInput(Key.down);
		else if (matchesKey(data, Key.pageUp)) this.list.handleInput(Key.pageUp);
		else if (matchesKey(data, Key.pageDown)) this.list.handleInput(Key.pageDown);
		else if (matchesKey(data, Key.enter) || keys.matches(data, "tui.select.confirm")) this.activateSelected();
		else if (this.mode === "stash" && matchesKey(data, Key.ctrl("a"))) this.activateSelected("apply");
		else if (this.mode === "stash" && matchesKey(data, Key.ctrl("x"))) this.activateSelected("drop");
		else {
			this.input.handleInput(data);
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "leave") return this.list.onMouse({ ...event, row: event.row - this.listStart });
		if (event.row >= this.listStart && event.row < this.listStart + this.listHeight)
			return this.list.onMouse({ ...event, row: event.row - this.listStart });
		return false;
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		const frameWidth = Math.max(4, width);
		const inner = frameWidth - 2;
		const border = (text: string) => colors.fg("border", text);
		const heading = truncateToWidth(this.title, Math.max(0, inner - 3), "");
		const headingWidth = visibleWidth(`─ ${heading} `);
		const lines = [
			`${border("╭─ ")}${colors.fg("accent", this.theme.bold(heading))}${border(` ${"─".repeat(Math.max(0, inner - headingWidth))}╮`)}`,
			colors.fg("text.muted", "Type to fuzzy-filter prompt text or session name"),
		];
		const renderedInput = this.input.render(Math.max(1, inner - 2))[0] ?? "";
		const search = renderedInput.startsWith("> ") ? renderedInput : `> ${renderedInput}`;
		lines.push(` ${truncateToWidth(search, inner - 2, "")}`);
		if (this.progress) lines.push(colors.fg("text.muted", this.progress));
		this.listStart = lines.length;
		const listLines = this.list.render(Math.max(1, inner - 2));
		this.listHeight = listLines.length;
		lines.push(...listLines.map((line) => ` ${line}`));
		if (this.filtered.length === 0) lines.push(` ${colors.fg("warning", "No matching prompts")}`);
		lines.push(
			colors.fg(
				"text.muted",
				this.mode === "stash"
					? "enter pop · ctrl+a apply · ctrl+x drop · ↑↓ move · esc cancel"
					: "enter apply · ↑↓ move · esc cancel",
			),
		);
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return [
			lines[0]!,
			...lines.slice(1, -1).map((line) => `${border("│")}${fitLine(line, inner)}${border("│")}`),
			lines.at(-1)!,
		].map((line) => truncateToWidth(line, frameWidth, ""));
	}

	private renderItem(item: PromptItem, context: SelectableListRenderContext): string {
		const colors = tuiTheme(this.theme);
		const prefix = context.selected ? colors.fg("accent", "❯ ") : "  ";
		const source = highlighted(sourceLabel(item), this.input.getValue(), this.theme, context.selected);
		const text =
			item.kind === "stash" ? "" : highlighted(preview(item.text, 70), this.input.getValue(), this.theme, false);
		const cwd = colors.fg("text.muted", relative(process.env.HOME ?? "", item.cwd) || item.cwd);
		const image = item.hasImages ? colors.fg("warning", " 🖼") : "";
		return `${prefix}${source}${image} ${colors.fg("text.muted", dateLabel(item.timestamp))}${text ? ` ${text}` : ""} ${cwd}`;
	}

	private applyFilter(): void {
		this.filtered = filterPrompts(this.items, this.input.getValue(), this.config.history.maxResults);
		this.list.setItems(this.filtered);
	}
	private activateSelected(action?: PromptAction): void {
		const item = this.list.getSelectedItem();
		if (item)
			this.choose(
				action ?? (this.mode === "stash" && this.config.picker.enterAction === "pop" ? "pop" : "apply"),
				item,
			);
	}
	private choose(action: PromptAction, item: PromptItem): void {
		this.finish({ item, action });
	}
	private finish(result: PickerResult | null): void {
		this.stopWatching?.();
		this.stopWatching = undefined;
		this.done(result);
	}
	private progressLabel(progress: IndexProgress | undefined): string | undefined {
		if (!progress) return undefined;
		return `Indexing ${progress.phase === "sessions" ? "sessions" : "prompts"} ${progress.loaded}/${progress.total}…`;
	}
}

export async function openPromptPicker(
	ctx: ExtensionContext,
	title: string,
	items: readonly PromptItem[],
	config: PromptStorageConfig,
	mode: PromptKind,
	index: PromptIndexView,
	selected?: PromptItem["id"],
): Promise<PickerResult | null> {
	if (items.length === 0) {
		ctx.ui.notify(mode === "stash" ? "No stashes." : "No prompt history found.", "info");
		return null;
	}
	return ctx.ui.custom<PickerResult | null>(
		(tui, theme, keys, done) =>
			mode === "stash"
				? createStashPicker(tui, theme, keys, done, items, config, selected)
				: new PromptPicker(tui, theme, title, items, config, mode, done, index, ctx.cwd),
		{
			overlay: true,
			overlayOptions:
				mode === "stash"
					? { anchor: "bottom-left", width: "100%" }
					: { anchor: "center", width: "90%", maxHeight: "90%" },
		},
	);
}
