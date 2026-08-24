import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type Focusable,
	type KeybindingsManager,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import type { ActionPanelFooter, ActionPanelMouseEvent, ActionPanelRect } from "../controls/action-panel.ts";
import { markEditorCursor } from "../cursor.ts";
import { resolveTuiTitle, type TuiTitleValue } from "../decoration/status.ts";
import { semanticEditorTheme } from "../editor.ts";
import { fitLine } from "../line-layout.ts";

function isEditorBorder(line: string): boolean {
	const plain = stripTerminalSequences(line);
	return /^[↑↓]?─+$/.test(plain);
}

/** Remove only Pi Editor's top and bottom rules, preserving autocomplete rows. */
function withoutEditorBorders(lines: readonly string[]): string[] {
	const result = [...lines];
	if (result[0] !== undefined && isEditorBorder(result[0])) result.shift();
	const bottom = result.findIndex((line, index) => index > 0 && isEditorBorder(line));
	if (bottom >= 0) result.splice(bottom, 1);
	return result;
}

/** Keep the cursor visible when a wrapper has fewer rows than Editor rendered. */
function keepCursorVisible(lines: readonly string[], maxRows: number): string[] {
	if (maxRows <= 0 || lines.length <= maxRows) return maxRows <= 0 ? [] : [...lines];
	const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	const start = cursor < 0 ? 0 : Math.min(cursor, lines.length - maxRows);
	return lines.slice(start, start + maxRows);
}

/** Last rendered bounds for a {@link FramedEditorOverlay}. */
export interface FramedEditorOverlayGeometry extends ActionPanelRect {
	/** Bounds of the optional footer row, relative to the overlay's top-left cell. */
	footer?: ActionPanelRect;
}

/** Construction options for a bounded native Pi multiline editor. */
export interface FramedEditorOverlayOptions {
	/** TUI instance used by Pi's native editor for rendering and terminal measurements. */
	tui: TUI;
	/** Active Pi theme; pi-libtui maps it to semantic editor and frame colors. */
	theme: Theme;
	/** Active keybindings used to recognize semantic cancel input. */
	keybindings: KeybindingsManager;
	/** Static or semantic title rendered inside the top border. */
	title: TuiTitleValue;
	/** Initial editor text. Omit to start with Pi's default empty value. */
	prefill?: string;
	/** Maximum rendered width, including the two frame columns. */
	maxWidth?: number;
	/** Maximum rendered height, including frame, separator, and footer rows. */
	maxHeight?: number;
	/** Hide Pi Editor's horizontal rules when the outer frame is sufficient. */
	editorBorders?: boolean;
	/** A single component row rendered below an internal separator. */
	footer?: ActionPanelFooter;
	/** Options forwarded unchanged to Pi's native `Editor` constructor. */
	editorOptions?: EditorOptions;
	/** Called with the current editor text when Pi accepts submit input. */
	onSubmit(text: string): void;
	/** Called when input matches the semantic `tui.select.cancel` binding. */
	onCancel(): void;
}

/** A small framed multiline overlay that delegates all text editing to Pi's Editor. */
export class FramedEditorOverlay implements Component, Focusable {
	private readonly editor: Editor;
	private _focused = false;
	private footerPointerInside = false;
	private geometry: FramedEditorOverlayGeometry | undefined;

	/**
	 * Create a framed editor and initialize its native editor state.
	 * @param config Theme, bounds, editor behavior, and completion callbacks.
	 */
	constructor(private readonly config: FramedEditorOverlayOptions) {
		this.editor = new Editor(config.tui, semanticEditorTheme(config.theme), config.editorOptions);
		this.editor.onSubmit = config.onSubmit;
		if (config.prefill !== undefined) this.editor.setText(config.prefill);
	}

	/** Whether this overlay and its native editor currently own focus. */
	get focused(): boolean {
		return this._focused;
	}

	/**
	 * Transfer focus to or from both the frame and its native editor.
	 * @param value Whether the editor should own focus.
	 */
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	/** @returns The native editor's current unrendered text. */
	getText(): string {
		return this.editor.getText();
	}

	/**
	 * Replace all editor text and reset the native editor to that value.
	 * @param text Complete unrendered value to install in the native editor.
	 */
	setText(text: string): void {
		this.editor.setText(text);
	}

	/**
	 * Route terminal input through cancel, footer shortcuts, then the native editor.
	 * @param data Raw terminal input received by the focused component.
	 */
	handleInput(data: string): void {
		if (this.config.keybindings.matches(data, "tui.select.cancel")) {
			this.config.onCancel();
			return;
		}
		if (this.config.footer?.handleInput?.(data) === true) return;
		this.editor.handleInput(data);
	}

	/**
	 * Route overlay-local pointer input to the optional footer.
	 * @param event Pointer coordinates relative to the framed overlay.
	 * @returns `true` when the event targets the footer; otherwise `false`.
	 */
	handleMouse(event: ActionPanelMouseEvent): boolean {
		if (event.type === "leave") {
			this.leaveFooter(event);
			return false;
		}
		const footer = this.geometry?.footer;
		if (
			!footer ||
			event.col < footer.x ||
			event.col >= footer.x + footer.width ||
			event.row < footer.y ||
			event.row >= footer.y + footer.height
		) {
			this.leaveFooter(event);
			return false;
		}
		const translated = { ...event, row: event.row - footer.y, col: event.col - footer.x };
		if (!this.footerPointerInside) {
			this.footerPointerInside = true;
			this.config.footer?.handleMouse?.({ ...translated, type: "enter" });
		}
		if (event.type !== "enter") this.config.footer?.handleMouse?.(translated);
		return true;
	}

	/**
	 * @returns A defensive copy of the last rendered bounds, or `undefined`
	 * before rendering, after invalidation, or when the available size is too small.
	 */
	getGeometry(): FramedEditorOverlayGeometry | undefined {
		if (!this.geometry) return undefined;
		return {
			...this.geometry,
			footer: this.geometry.footer ? { ...this.geometry.footer } : undefined,
		};
	}

	/** Invalidate the native editor, footer, and cached render geometry. */
	invalidate(): void {
		this.editor.invalidate();
		this.config.footer?.invalidate?.();
		this.geometry = undefined;
	}

	/**
	 * Render the frame, visible editor rows, and optional one-row footer.
	 * @param availableWidth Maximum columns offered by the parent layout.
	 * @returns ANSI-styled rows bounded by `availableWidth`, `maxWidth`, and
	 * `maxHeight`; returns no rows when the bounds cannot fit editor chrome.
	 */
	render(availableWidth: number): string[] {
		const colors = tuiTheme(this.config.theme);
		const width = Math.max(0, Math.min(availableWidth, this.config.maxWidth ?? availableWidth));
		const maxHeight = Math.max(0, Math.floor(this.config.maxHeight ?? Number.POSITIVE_INFINITY));
		const chromeRows = this.config.footer ? 4 : 2;
		if (width < 4 || maxHeight < chromeRows + 1) {
			this.geometry = undefined;
			return [];
		}
		const innerWidth = width - 2;
		const visibleTitle = truncateToWidth(resolveTuiTitle(this.config.title), Math.max(0, innerWidth - 3), "");
		const usedTitleWidth = visibleWidth(`─ ${visibleTitle} `);
		const top =
			colors.fg("border", "╭─ ") +
			colors.fg("accent", this.config.theme.bold(visibleTitle)) +
			colors.fg("border", ` ${"─".repeat(Math.max(0, innerWidth - usedTitleWidth))}╮`);
		const bottom = colors.fg("border", `╰${"─".repeat(innerWidth)}╯`);
		// Only the focused overlay can claim the screen's semantic cursor.
		const editorLines = this.editor
			.render(innerWidth)
			.map((line) => markEditorCursor(line, { theme: this.config.theme, role: "insertion" }));
		const content = this.config.editorBorders === false ? withoutEditorBorders(editorLines) : editorLines;
		const maxContent = maxHeight - chromeRows;
		const lines = [
			top,
			...keepCursorVisible(content, maxContent).map(
				(line) => `${colors.fg("border", "│")}${fitLine(line, innerWidth)}${colors.fg("border", "│")}`,
			),
		];
		let footer: ActionPanelRect | undefined;
		if (this.config.footer) {
			lines.push(colors.fg("border", `├${"─".repeat(innerWidth)}┤`));
			const y = lines.length;
			const content = this.config.footer.render(innerWidth)[0] ?? "";
			lines.push(`${colors.fg("border", "│")}${fitLine(content, innerWidth)}${colors.fg("border", "│")}`);
			footer = { x: 1, y, width: innerWidth, height: 1 };
		}
		lines.push(bottom);
		this.geometry = { x: 0, y: 0, width, height: lines.length, footer };
		return lines;
	}

	private leaveFooter(event: ActionPanelMouseEvent): void {
		if (!this.footerPointerInside) return;
		this.footerPointerInside = false;
		this.config.footer?.handleMouse?.({ ...event, type: "leave", row: -1, col: -1 });
	}
}
