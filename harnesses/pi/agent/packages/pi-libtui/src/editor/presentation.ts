import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";

/**
 * Adapt pi-libtui semantic colors to every color role in Pi's native editor.
 * @param theme Active Pi theme used to generate semantic pi-libtui colors.
 * @returns A complete native `EditorTheme` for borders and autocomplete rows.
 */
export function semanticEditorTheme(theme: Theme): EditorTheme {
	const colors = tuiTheme(theme);
	return {
		borderColor: (text) => colors.fg("border", text),
		selectList: {
			selectedPrefix: (text) => colors.fg("accent", text),
			selectedText: (text) => colors.fg("accent", text),
			description: (text) => colors.fg("text.muted", text),
			scrollInfo: (text) => colors.fg("text.muted", text),
			noMatch: (text) => colors.fg("text.muted", text),
		},
	};
}

/** Pi's extensible editor with all native color roles owned by pi-libtui. */
export class SemanticEditor extends CustomEditor {
	/**
	 * Create an extensible Pi editor backed by pi-libtui semantic colors.
	 * @param tui TUI instance used by the native editor.
	 * @param theme Active Pi theme converted through {@link semanticEditorTheme}.
	 * @param keybindings Active application keybindings forwarded to `CustomEditor`.
	 */
	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		super(tui, semanticEditorTheme(theme), keybindings);
	}
}
