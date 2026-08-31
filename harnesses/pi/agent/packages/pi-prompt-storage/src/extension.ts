import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "pi-libtui";
import { installEditorLayer as installLayer } from "pi-libtui/editor";
import { SemanticEditor } from "pi-libtui/editor";
import { loadConfig } from "./config.ts";
import {
	preview,
	sourceLabel,
	stashWidgetLine,
	type PromptAction,
	type PromptItem,
	type PromptStorageConfig,
} from "./core/model.ts";
import { PromptStorageStore } from "./runtime/store.ts";
import { openPromptPicker } from "./ui/picker.ts";

const EDITOR_LAYER = Symbol.for("pi-prompt-storage/editor-layer");
const STASH_WIDGET = "pi-prompt-storage.stashes";

function installEditor(ctx: ExtensionContext, config: PromptStorageConfig, store: PromptStorageStore): () => void {
	return installLayer(ctx.ui, EDITOR_LAYER, (previous) => (tui, editorTheme, keybindings) => {
		const editor = previous?.(tui, editorTheme, keybindings) ?? new SemanticEditor(tui, ctx.ui.theme, keybindings);
		for (const prompt of store.branchPrompts(ctx, config)) editor.addToHistory?.(prompt);
		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string): void => {
			const current = ctx.ui.getEditorText();
			const action = matchesKey(data, config.shortcuts.stash as never) ? (current.trim() ? "stash" : "pop") : undefined;
			if (!action) {
				handleInput(data);
				return;
			}
			void runAction(ctx, store, config, action, current).catch((error) => {
				ctx.ui.notify(`Prompt storage failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		};
		return editor;
	});
}

async function runAction(
	ctx: ExtensionContext,
	store: PromptStorageStore,
	config: PromptStorageConfig,
	action: "stash" | "pop" | "history",
	current: string,
): Promise<void> {
	if (action === "stash") {
		if (!current.trim()) {
			ctx.ui.notify("Nothing to stash — editor is empty.", "warning");
			return;
		}
		await store.insert(current, ctx.cwd);
		ctx.ui.setEditorText("");
		await updateWidget(ctx, store);
		ctx.ui.notify(`Stashed: ${preview(current, 60)}`, "info");
		return;
	}
	let items = action === "pop" ? await store.listStashes(ctx.cwd) : await store.listHistory(ctx, config);
	if (items.length === 0) {
		ctx.ui.notify(action === "pop" ? "No stashes." : "No prompt history found.", "info");
		return;
	}
	if (action === "pop" && items.length === 1) {
		await apply(ctx, store, items[0]!, "pop");
		return;
	}
	let selectedStash: PromptItem["id"] | undefined;
	for (;;) {
		const result = await openPromptPicker(
			ctx,
			action === "pop" ? "Prompt Stash" : "Prompt History",
			items,
			config,
			action === "pop" ? "stash" : "history",
			{
				progress: (cwd) => store.getProgress(cwd),
				watch: (cwd, listener) => store.watch(cwd, listener),
			},
			selectedStash,
		);
		if (!result) return;
		if (result.action === "drop") {
			selectedStash = result.selectionAfterDrop;
			if (typeof result.item.id === "number") await store.remove(result.item.id);
			await updateWidget(ctx, store);
			ctx.ui.notify(`Dropped ${sourceLabel(result.item)}`, "info");
			items = await store.listStashes(ctx.cwd);
			if (items.length === 0) return;
			continue;
		}
		await apply(ctx, store, result.item, result.action);
		return;
	}
}

async function apply(
	ctx: ExtensionContext,
	store: PromptStorageStore,
	item: PromptItem,
	action: PromptAction,
): Promise<void> {
	const current = ctx.ui.getEditorText();
	const saved = current.trim() && current !== item.text;
	if (saved) await store.insert(current, ctx.cwd);
	ctx.ui.setEditorText(item.text);
	if (action === "pop" && typeof item.id === "number") await store.remove(item.id);
	await updateWidget(ctx, store);
	ctx.ui.notify(
		`${action === "pop" ? "Popped" : "Applied"} ${sourceLabel(item)}${saved ? "; current draft auto-stashed" : ""}`,
		"info",
	);
}

async function updateWidget(ctx: ExtensionContext, store: PromptStorageStore): Promise<void> {
	if (ctx.mode !== "tui") return;
	const items = await store.listStashes(ctx.cwd);
	ctx.ui.setWidget(
		STASH_WIDGET,
		items.length === 0
			? undefined
			: (_tui, theme) => ({
					render: (width: number) => [
						truncateToWidth(tuiTheme(theme).fg("text.muted", stashWidgetLine(items)), width, ""),
					],
					invalidate() {},
				}),
	);
}

export default function promptStorageExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const store = new PromptStorageStore();
	let removeEditor: (() => void) | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") removeEditor = installEditor(ctx, config, store);
		store.refreshSoon(ctx.cwd, config);
		await updateWidget(ctx, store);
	});
	pi.registerCommand("prompt-history", {
		description: "Search and apply prompt history",
		handler: async (_args, ctx) => {
			await runAction(ctx, store, config, "history", ctx.ui.getEditorText());
		},
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		removeEditor?.();
		removeEditor = undefined;
		ctx.ui.setWidget(STASH_WIDGET, undefined);
		await store.close();
	});
}
