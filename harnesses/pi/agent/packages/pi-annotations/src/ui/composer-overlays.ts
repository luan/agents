import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
	ActionPanel,
	DialogButtonBar,
	FramedEditorOverlay,
	type ModalOverlayMouseEvent,
	mountModalOverlay,
	placeAnchoredOverlay,
} from "pi-libtui";
import type { MouseRegistry } from "pi-libtui/mouse";
import type { SelectionPoint } from "pi-libtui/selection";

export type CommentOverlayResult = { action: "save"; text: string } | { action: "delete" };
export type ReactionOverlayResult = { action: "save"; text: string };

export async function showReactionOverlay(
	ctx: ExtensionContext,
	registry: MouseRegistry,
	anchor: SelectionPoint,
	reactions: readonly string[],
	horizontalPlacement: "adjacent" | "center" = "adjacent",
): Promise<ReactionOverlayResult | undefined> {
	if (ctx.mode !== "tui") {
		const reaction = await ctx.ui.select("React", [...reactions]);
		return reaction === undefined ? undefined : { action: "save", text: reaction };
	}
	const terminal = currentTerminalSize();
	const height = Math.min(Math.max(5, reactions.length + 4), 13, terminal.terminalRows);
	const placement = placeAnchoredOverlay({
		...terminal,
		anchorRow: anchor.row,
		anchorCol: anchor.col,
		desiredWidth: 44,
		height,
		horizontalPlacement,
	});
	return ctx.ui.custom<ReactionOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const dialog = new ReactionDialog({
				tui,
				theme,
				keybindings,
				reactions,
				width: placement.rect.width,
				height: placement.rect.height,
				done,
			});
			return mountModalOverlay(dialog, {
				registry,
				id: "pi-annotations.reaction-picker",
				getRect: () => placement.rect,
				getShieldRect: () => ({ x: 0, y: 0, width: terminal.terminalCols, height: terminal.terminalRows }),
			});
		},
		{ overlay: true, overlayOptions: placement.options },
	);
}

export async function showCommentOverlay(
	ctx: ExtensionContext,
	registry: MouseRegistry,
	anchor: SelectionPoint,
	prefill = "",
	canDelete = false,
	horizontalPlacement: "adjacent" | "center" = "adjacent",
): Promise<CommentOverlayResult | undefined> {
	if (ctx.mode !== "tui") {
		const text = await ctx.ui.editor("Annotate", prefill);
		return text && text.trim().length > 0 ? { action: "save", text } : undefined;
	}
	const terminal = currentTerminalSize();
	const placement = placeAnchoredOverlay({
		...terminal,
		anchorRow: anchor.row,
		anchorCol: anchor.col,
		desiredWidth: 60,
		height: 9,
		horizontalPlacement,
	});
	return ctx.ui.custom<CommentOverlayResult | undefined>(
		(tui, theme, keybindings, done) => {
			const dialog = new CommentDialog({
				tui,
				theme,
				keybindings,
				prefill,
				canDelete,
				width: placement.rect.width,
				height: placement.rect.height,
				done,
			});
			return mountModalOverlay(dialog, {
				registry,
				id: "pi-annotations.comment-editor",
				getRect: () => placement.rect,
				getShieldRect: () => ({ x: 0, y: 0, width: terminal.terminalCols, height: terminal.terminalRows }),
			});
		},
		{ overlay: true, overlayOptions: placement.options },
	);
}

interface ReactionDialogOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	reactions: readonly string[];
	width: number;
	height: number;
	done(result: ReactionOverlayResult | undefined): void;
}

export class ReactionDialog implements Component, Focusable {
	private readonly panel: ActionPanel<string>;
	private readonly buttons: DialogButtonBar<"cancel" | "save">;
	focused = false;

	constructor(private readonly options: ReactionDialogOptions) {
		this.buttons = new DialogButtonBar({
			theme: options.theme,
			buttons: [
				{
					value: "cancel",
					label: "CANCEL",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: ["escape"],
					align: "end",
				},
				{
					value: "save",
					label: "ADD",
					icon: "submit",
					foreground: "positive",
					background: "action.positive",
					shortcuts: ["enter"],
					align: "end",
				},
			],
			requestRender: () => options.tui.requestRender(),
			onActivate: (action) => this.activate(action),
		});
		this.panel = new ActionPanel({
			theme: options.theme,
			keybindings: options.keybindings,
			title: "React",
			options: options.reactions.map((reaction) => ({ value: reaction, label: reaction })),
			maxVisible: Math.max(1, options.height - 4),
			maxWidth: options.width,
			maxHeight: options.height,
			numberShortcuts: true,
			footer: this.buttons,
			requestRender: () => options.tui.requestRender(),
			onSelect: (reaction) => options.done({ action: "save", text: reaction }),
			onCancel: () => options.done(undefined),
		});
	}

	handleInput(data: string): void {
		if (this.options.keybindings.matches(data, "tui.select.cancel")) {
			this.activate("cancel");
			return;
		}
		if (this.options.keybindings.matches(data, "tui.input.submit")) {
			this.activate("save");
			return;
		}
		if (this.buttons.handleInput(data)) return;
		// Number shortcuts retain the established r1 quick-confirm path. Other
		// navigation only moves selection until Add/Enter is activated.
		this.panel.handleInput(data);
	}

	handleMouse(event: ModalOverlayMouseEvent): boolean {
		return this.panel.handleMouse(event);
	}

	getOptionRects(): ReadonlyArray<{ value: string; x: number; y: number; width: number; height: number }> {
		return (this.panel.getGeometry()?.rows ?? []).map((row) => ({
			value: row.value,
			x: row.x,
			y: row.y,
			width: row.width,
			height: row.height,
		}));
	}

	getButtonRects(): ReadonlyArray<{ value: "cancel" | "save"; x: number; y: number; width: number; height: number }> {
		const footer = this.panel.getGeometry()?.footer;
		if (!footer) return [];
		return (this.buttons.getGeometry()?.buttons ?? []).map((button) => ({
			value: button.value,
			x: footer.x + button.x,
			y: footer.y + button.y,
			width: button.width,
			height: button.height,
		}));
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	render(width: number): string[] {
		return this.panel.render(Math.min(width, this.options.width));
	}

	private activate(action: "cancel" | "save"): void {
		if (action === "cancel") {
			this.options.done(undefined);
			return;
		}
		const text = this.panel.getSelectedValue();
		if (text !== undefined) this.options.done({ action: "save", text });
	}
}

interface CommentDialogOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	prefill: string;
	canDelete: boolean;
	width: number;
	height: number;
	done(result: CommentOverlayResult | undefined): void;
}

export class CommentDialog implements Component, Focusable {
	private readonly editor: FramedEditorOverlay;
	private readonly buttons: DialogButtonBar<"delete" | "cancel" | "save">;

	constructor(private readonly options: CommentDialogOptions) {
		this.buttons = new DialogButtonBar({
			theme: options.theme,
			buttons: [
				...(options.canDelete
					? [
							{
								value: "delete" as const,
								label: "DELETE",
								icon: "delete" as const,
								foreground: "negative" as const,
								background: "action.negative" as const,
								shortcuts: ["ctrl+d"] as const,
								align: "start" as const,
							},
						]
					: []),
				{
					value: "cancel",
					label: "CANCEL",
					icon: "cancel",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: ["escape"],
					align: "end",
				},
				{
					value: "save",
					label: "ADD",
					icon: "submit",
					foreground: "positive",
					background: "action.positive",
					shortcuts: ["enter"],
					align: "end",
				},
			],
			gap: 1,
			requestRender: () => options.tui.requestRender(),
			onActivate: (action) => this.activate(action),
		});
		this.editor = new FramedEditorOverlay({
			tui: options.tui,
			theme: options.theme,
			keybindings: options.keybindings,
			title: "Annotate",
			prefill: options.prefill,
			maxWidth: options.width,
			maxHeight: options.height,
			editorBorders: false,
			footer: this.buttons,
			editorOptions: { paddingX: 0 },
			onSubmit: (text) => {
				if (text.trim().length > 0) options.done({ action: "save", text });
			},
			onCancel: () => options.done(undefined),
		});
	}

	get focused(): boolean {
		return this.editor.focused;
	}
	set focused(value: boolean) {
		this.editor.focused = value;
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	handleMouse(event: ModalOverlayMouseEvent): boolean {
		return this.editor.handleMouse(event);
	}

	getButtonRects(): ReadonlyArray<{
		value: "delete" | "cancel" | "save";
		x: number;
		y: number;
		width: number;
		height: number;
	}> {
		const footer = this.editor.getGeometry()?.footer;
		if (!footer) return [];
		return (this.buttons.getGeometry()?.buttons ?? []).map((button) => ({
			value: button.value,
			x: footer.x + button.x,
			y: footer.y + button.y,
			width: button.width,
			height: button.height,
		}));
	}

	invalidate(): void {
		this.editor.invalidate();
	}
	render(availableWidth: number): string[] {
		return this.editor.render(availableWidth);
	}

	private activate(action: "delete" | "cancel" | "save"): void {
		if (action === "cancel") {
			this.options.done(undefined);
			return;
		}
		if (action === "delete") {
			if (this.options.canDelete) this.options.done({ action: "delete" });
			return;
		}
		const text = this.editor.getText();
		if (text.trim().length > 0) this.options.done({ action: "save", text });
	}
}

// Pi 0.84.2 needs overlay options before the factory receives its TUI reference.
// Use the process terminal size once, then share that exact placement with Pi,
// the dialog, and the mouse region.
function currentTerminalSize(): { terminalCols: number; terminalRows: number } {
	return { terminalCols: process.stdout.columns || 80, terminalRows: process.stdout.rows || 24 };
}
