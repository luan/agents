import { homedir } from "node:os";
import { relative } from "node:path";
import {
	CustomEditor,
	DynamicBorder,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyMatch,
	Input,
	Key,
	matchesKey,
	Spacer,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	defineExtensionTui,
	type EditorFactory,
	type EditorUi,
	installEditorLayer,
	removeEditorLayer,
	setOrderedAboveEditorWidget,
	textComponent,
} from "../shared/tui";

export type PromptKind = "stash" | "history";
export type PickerAction = "apply" | "pop" | "drop";

export interface PromptStorageConfig {
	shortcuts: { stash: string; pop: string; history: string };
	history: { includeSlashCommands: boolean; maxResults: number };
	picker: { maxVisible: number; enterAction: "apply" | "pop" };
}

export interface PromptItem {
	kind: PromptKind;
	id: number | string;
	text: string;
	timestamp: number;
	cwd: string;
	sessionPath?: string;
	sessionName?: string;
	hasImages?: boolean;
	searchText: string;
}

export interface PickerResult {
	item: PromptItem;
	action: PickerAction;
}

export interface IndexProgress {
	phase: "sessions" | "prompts";
	loaded: number;
	total: number;
}

export interface PromptIndexPresentation {
	progress(cwd: string): IndexProgress | undefined;
	watch(cwd: string, listener: (progress: IndexProgress | undefined) => void): () => void;
}

const promptStorageTui = defineExtensionTui({ id: "prompt-storage" });
const stashHudWidgetId = "prompt-storage-stash";
const EDITOR_LAYER_ID = Symbol.for("prompt-storage.editorShortcutLayer");
let stashHud: StashHudWidget | undefined;
let stashHudLines: string[] = [];
let restackTimer: ReturnType<typeof setTimeout> | undefined;

function preview(value: string, max = 90): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`;
}

function dateLabel(timestamp: number): string {
	return new Date(timestamp).toLocaleString("en-GB", {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}
function indexProgressLabel(progress: IndexProgress | undefined): string | undefined {
	if (!progress) return undefined;
	const noun = progress.phase === "sessions" ? "sessions" : "prompts";
	return `Indexing ${noun} ${progress.loaded}/${progress.total}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sourceLabel(item: PromptItem): string {
	if (item.kind === "stash") return preview(item.text, 48);
	if (item.sessionName?.trim()) return item.sessionName.trim();
	return "History";
}

function searchTokens(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function fuzzyIndexes(token: string, text: string): number[] | undefined {
	const textLower = text.toLowerCase();
	const indexes: number[] = [];
	let searchFrom = 0;
	for (;;) {
		const exactIndex = textLower.indexOf(token, searchFrom);
		if (exactIndex === -1) break;
		for (let index = exactIndex; index < exactIndex + token.length; index++) indexes.push(index);
		searchFrom = exactIndex + Math.max(1, token.length);
	}
	if (indexes.length > 0) return indexes;

	let queryIndex = 0;
	for (let textIndex = 0; textIndex < textLower.length && queryIndex < token.length; textIndex++) {
		if (textLower[textIndex] === token[queryIndex]) {
			indexes.push(textIndex);
			queryIndex++;
		}
	}
	return queryIndex === token.length ? indexes : undefined;
}

function queryMatchIndexes(text: string, query: string): Set<number> {
	const indexes = new Set<number>();
	for (const token of searchTokens(query)) {
		const tokenIndexes = fuzzyIndexes(token, text);
		if (!tokenIndexes) continue;
		for (const index of tokenIndexes) indexes.add(index);
	}
	return indexes;
}

function highlightSearchText(text: string, query: string, theme: Theme, baseColor: ThemeColor): string {
	const indexes = queryMatchIndexes(text, query);
	if (indexes.size === 0) return theme.fg(baseColor, text);

	let rendered = "";
	let runStart = 0;
	let runHighlighted = indexes.has(0);
	for (let index = 1; index <= text.length; index++) {
		const highlighted = index < text.length && indexes.has(index);
		if (highlighted === runHighlighted && index < text.length) continue;

		const segment = text.slice(runStart, index);
		rendered += runHighlighted ? theme.fg("warning", theme.bold(segment)) : theme.fg(baseColor, segment);
		runStart = index;
		runHighlighted = highlighted;
	}
	return rendered;
}

class StashHudWidget implements Component {
	private lines: string[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {
		this.lines = stashHudLines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		stashHudLines = lines;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.lines.map((line) => truncateToWidth(this.dim(line), width));
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private dim(line: string): string {
		return this.theme.fg("dim", line);
	}
}

function searchableFields(item: PromptItem): string[] {
	const fields = [item.text];
	if (item.sessionName?.trim()) fields.push(item.sessionName.trim());
	return fields;
}

function itemMatchScore(item: PromptItem, tokens: string[]): number | undefined {
	const phrase = tokens.join(" ");
	const text = item.text.toLowerCase();
	let totalScore = 0;

	if (text === phrase) totalScore -= 10_000;
	else {
		const phraseIndex = text.indexOf(phrase);
		if (phraseIndex >= 0) totalScore -= 5_000 + phraseIndex * 0.1;
	}

	for (const token of tokens) {
		let bestScore: number | undefined;
		for (const field of searchableFields(item)) {
			const fieldLower = field.toLowerCase();
			const exactIndex = fieldLower.indexOf(token);
			if (exactIndex >= 0) {
				const score = -1_000 + exactIndex * 0.1;
				bestScore = bestScore === undefined ? score : Math.min(bestScore, score);
				continue;
			}
			const match = fuzzyMatch(token, field);
			if (match.matches) bestScore = bestScore === undefined ? match.score : Math.min(bestScore, match.score);
		}
		if (bestScore === undefined) return undefined;
		totalScore += bestScore;
	}
	return totalScore;
}

function filterItems(items: PromptItem[], query: string, limit: number): PromptItem[] {
	const tokens = searchTokens(query);
	if (tokens.length === 0) return items.slice(0, limit);
	return items
		.map((item) => ({ item, score: itemMatchScore(item, tokens) }))
		.filter((result): result is { item: PromptItem; score: number } => result.score !== undefined)
		.sort((a, b) => a.score - b.score || b.item.timestamp - a.item.timestamp)
		.map((result) => result.item)
		.slice(0, limit);
}

class PromptPicker extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly list = new Container();
	private filtered: PromptItem[] = [];
	private selected = 0;
	private focusedValue = false;
	private indexStatus?: string;
	private stopWatchingIndex: (() => void) | undefined;
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		title: string,
		private readonly items: PromptItem[],
		private readonly config: PromptStorageConfig,
		private readonly mode: PromptKind,
		private readonly done: (result: PickerResult | null) => void,
		private readonly index: PromptIndexPresentation,
		indexCwd?: string,
	) {
		super();
		this.indexStatus = indexProgressLabel(indexCwd ? this.index.progress(indexCwd) : undefined);
		if (indexCwd) {
			this.stopWatchingIndex = this.index.watch(indexCwd, (progress) => {
				this.indexStatus = indexProgressLabel(progress);
				this.rebuildList();
				this.tui.requestRender();
			});
		}
		this.searchInput.onSubmit = () => this.choose(this.mode === "stash" ? "pop" : "apply");
		this.searchInput.onEscape = () => this.finish(null);
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(textComponent(theme.fg("accent", theme.bold(` ${title} `))));
		this.addChild(textComponent(theme.fg("dim", "Type to fuzzy-filter prompt text or session name")));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(textComponent(this.helpText()));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.applyFilter();
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p")) || data === "\u0010") {
			this.move(-1);
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n")) || data === "\u000e") {
			this.move(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.move(-this.config.picker.maxVisible);
		} else if (matchesKey(data, Key.pageDown)) {
			this.move(this.config.picker.maxVisible);
		} else if (matchesKey(data, Key.enter)) {
			this.choose(this.mode === "stash" ? "pop" : "apply");
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(null);
		} else if (this.mode === "stash" && matchesKey(data, Key.ctrl("a"))) {
			this.choose("apply");
		} else if (this.mode === "stash" && matchesKey(data, Key.ctrl("x"))) {
			this.choose("drop");
		} else {
			this.searchInput.handleInput(data);
			this.selected = 0;
			this.applyFilter();
		}
		this.tui.requestRender();
	}
	private finish(result: PickerResult | null): void {
		this.stopWatchingIndex?.();
		this.stopWatchingIndex = undefined;
		this.done(result);
	}

	private helpText(): string {
		const stashHelp = "enter pop • ctrl+a apply • ctrl+x drop • ↑↓/ctrl+n/ctrl+p move • esc cancel";
		const historyHelp = "enter apply • ↑↓ move • esc cancel";
		return this.theme.fg("dim", this.mode === "stash" ? stashHelp : historyHelp);
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
		this.rebuildList();
	}

	private choose(action: PickerAction): void {
		const item = this.filtered[this.selected];
		if (item) this.finish({ item, action });
	}

	private applyFilter(): void {
		this.filtered = filterItems(this.items, this.searchInput.getValue(), this.config.history.maxResults);
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
		this.rebuildList();
	}

	private rebuildList(): void {
		this.list.clear();
		if (this.indexStatus) {
			this.list.addChild(textComponent(this.theme.fg("dim", this.indexStatus)));
		}
		if (this.filtered.length === 0) {
			this.list.addChild(textComponent(this.theme.fg("warning", "No matching prompts")));
		} else {
			const max = Math.min(this.filtered.length, this.config.picker.maxVisible);
			for (let index = 0; index < max; index++) {
				this.list.addChild(textComponent(this.formatLine(this.filtered[index]!, index)));
			}
			if (this.filtered.length > max) {
				this.list.addChild(textComponent(this.theme.fg("muted", `(${this.selected + 1}/${this.filtered.length})`)));
			}
		}
	}

	private formatLine(item: PromptItem, index: number): string {
		const selected = index === this.selected;
		const query = this.searchInput.getValue();
		const pointer = selected ? this.theme.fg("accent", "❯ ") : "  ";
		const sourceColor = selected ? "accent" : "muted";
		const source =
			item.kind === "history" && !item.sessionName?.trim()
				? this.theme.fg(sourceColor, sourceLabel(item))
				: highlightSearchText(sourceLabel(item), query, this.theme, sourceColor);
		const text = highlightSearchText(preview(item.text, 78), query, this.theme, selected ? "text" : "dim");
		const img = item.hasImages ? this.theme.fg("warning", " 🖼") : "";
		const cwd = this.theme.fg("dim", relative(homedir(), item.cwd) || item.cwd);
		const prompt = item.kind === "stash" ? "" : ` ${text}`;
		return `${pointer}${source}${img} ${this.theme.fg("dim", dateLabel(item.timestamp))}${prompt} ${cwd}`;
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width));
	}
}

export function formatStashHudLines(stashes: PromptItem[]): string[] {
	return [
		`Prompt stash (${stashes.length})`,
		...stashes.map((stash) => {
			const cwd = relative(homedir(), stash.cwd) || stash.cwd;
			return `• ${preview(stash.text, 96)}  ${dateLabel(stash.timestamp)}  ${cwd}`;
		}),
	];
}

export function setStashHud(ctx: ExtensionContext, lines: string[]): void {
	stashHudLines = lines;
	if (lines.length === 0) {
		if (stashHud) setOrderedAboveEditorWidget(ctx, stashHudWidgetId, undefined);
		stashHud = undefined;
		return;
	}
	if (stashHud) {
		stashHud.setLines(lines);
		return;
	}
	installStashHud(ctx);
}

function installStashHud(ctx: ExtensionContext): void {
	if (stashHudLines.length === 0) return;
	setOrderedAboveEditorWidget(ctx, stashHudWidgetId, (tui, theme) => {
		stashHud = new StashHudWidget(tui, theme);
		return stashHud;
	});
}

export function restackPromptStashHud(ctx: ExtensionContext): void {
	if (stashHudLines.length === 0) {
		setStashHud(ctx, []);
		return;
	}
	if (restackTimer) clearTimeout(restackTimer);
	restackTimer = setTimeout(() => {
		restackTimer = undefined;
		try {
			installStashHud(ctx);
		} catch (error) {
			if (!errorMessage(error).includes("ctx is stale")) throw error;
		}
	}, 0);
}

export async function openPromptPicker(
	ctx: ExtensionContext,
	title: string,
	items: PromptItem[],
	config: PromptStorageConfig,
	mode: PromptKind,
	index: PromptIndexPresentation,
): Promise<PickerResult | null> {
	if (items.length === 0) {
		ctx.ui.notify(mode === "stash" ? "No stashes." : "No prompt history found.", "info");
		return null;
	}
	return promptStorageTui
		.bind(ctx)
		.overlays.openComponent<PickerResult | null>(
			(tui, theme, _keybindings, done) =>
				new PromptPicker(
					tui as TUI,
					theme as Theme,
					title,
					items,
					config,
					mode,
					done,
					index,
					mode === "history" ? ctx.cwd : undefined,
				),
			{ overlay: false },
		);
}

export interface PromptEditorActions {
	stash(ctx: ExtensionContext): Promise<void>;
	pop(ctx: ExtensionContext): Promise<void>;
	history(ctx: ExtensionContext): Promise<void>;
	currentPrompts(ctx: ExtensionContext): string[];
}

function runEditorAction(ctx: ExtensionContext, action: () => Promise<void>): void {
	void action().catch((error) => {
		ctx.ui.notify(`Prompt storage failed: ${errorMessage(error)}`, "error");
	});
}

export function installPromptStorageEditor(
	ctx: ExtensionContext,
	getContext: () => ExtensionContext | undefined,
	config: PromptStorageConfig,
	actions: PromptEditorActions,
): void {
	installEditorLayer(ctx.ui as unknown as EditorUi, EDITOR_LAYER_ID, (previous) => {
		const wrapped: EditorFactory = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const active = getContext();
			if (active) {
				for (const prompt of actions.currentPrompts(active)) editor.addToHistory?.(prompt);
			}
			const previousHandleInput = editor.handleInput?.bind(editor);
			editor.handleInput = (data: string) => {
				const current = getContext();
				if (!current) {
					previousHandleInput?.(data);
					return;
				}
				if (matchesKey(data, config.shortcuts.stash as never)) {
					runEditorAction(current, () => actions.stash(current));
					return;
				}
				if (matchesKey(data, config.shortcuts.pop as never)) {
					runEditorAction(current, () => actions.pop(current));
					return;
				}
				if (matchesKey(data, config.shortcuts.history as never)) {
					runEditorAction(current, () => actions.history(current));
					return;
				}
				previousHandleInput?.(data);
			};
			return editor as ReturnType<EditorFactory>;
		};
		return wrapped;
	});
}

export function shutdownPromptStoragePresentation(ctx: ExtensionContext): void {
	if (ctx.hasUI) removeEditorLayer(ctx.ui, EDITOR_LAYER_ID);
	if (restackTimer) clearTimeout(restackTimer);
	restackTimer = undefined;
	stashHud = undefined;
	stashHudLines = [];
}
