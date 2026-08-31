import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { markEditorCursor } from "pi-libtui";
import {
	type EditorFactory,
	type EditorMinimumRowsLease,
	editorCompositionContentWidth,
	installEditorLayer,
	installEditorMinimumRows,
	renderEditorComposition,
	SemanticEditor,
} from "pi-libtui/editor";
import { getCustomEditorSettings } from "../config/settings.ts";
import { resolveEditorComposition } from "../core/composition.ts";
import type { TuiState } from "../runtime/state.ts";
import { renderStatusGroups } from "./status.ts";

const EDITOR_LAYER = Symbol.for("pi-custom-editor/editor-layer");

export interface PiCustomEditorOptions {
	readonly ctx: ExtensionContext;
	readonly theme: Theme;
	readonly state: TuiState;
	readonly getThinkingLabel?: () => string | undefined;
	readonly layout: EditorMinimumRowsLease;
}

type TUI = Parameters<EditorFactory>[0];
type EditorTheme = Parameters<EditorFactory>[1];
type EditorComponent = ReturnType<EditorFactory>;

function isEditorBorder(line: string): boolean {
	const plain = stripTerminalSequences(line).trim();
	return /^─+$/u.test(plain) || /^─── [↑↓] \d+ more (?:─+|\.{1,3})$/u.test(plain);
}

function splitNativeRender(rendered: readonly string[]): { editorLines: string[]; autocompleteLines: string[] } {
	if (rendered.length < 3 || !isEditorBorder(rendered[0] ?? ""))
		return { editorLines: [...rendered], autocompleteLines: [] };
	const bottom = rendered.findIndex((line, index) => index >= 2 && isEditorBorder(line));
	if (bottom < 0) return { editorLines: [...rendered], autocompleteLines: [] };
	return { editorLines: rendered.slice(1, bottom), autocompleteLines: rendered.slice(bottom + 1) };
}

class CompositionRenderer {
	constructor(private readonly options: PiCustomEditorOptions) {}

	render(width: number, renderNative: (width: number) => string[]): string[] {
		const safeWidth = Math.max(1, width);
		const composition = resolveEditorComposition(getCustomEditorSettings());
		const elapsedMs = this.options.state.elapsed();
		const native = renderNative(editorCompositionContentWidth(composition.style, safeWidth));
		const { editorLines: rawEditorLines, autocompleteLines } = splitNativeRender(native);
		if (rawEditorLines.length === 0) return native;
		const content = rawEditorLines.map((line) =>
			markEditorCursor(line, { theme: this.options.theme, role: "insertion" }),
		);
		const topStatus = renderStatusGroups({
			ctx: this.options.ctx,
			state: this.options.state,
			theme: this.options.theme,
			left: composition.topLeftSegments,
			right: composition.topRightSegments,
			separator: composition.style.statusSeparator,
			width: safeWidth,
			getThinkingLabel: this.options.getThinkingLabel,
		});
		return [
			...autocompleteLines,
			...renderEditorComposition(this.options.theme, composition.style, {
				width: safeWidth,
				content,
				topStatus,
				active: this.options.state.active,
				elapsedMs,
			}),
		];
	}
}

export class PiCustomEditor extends SemanticEditor {
	private readonly composition: CompositionRenderer;

	constructor(
		tui: TUI,
		_editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly options: PiCustomEditorOptions,
	) {
		super(tui, options.theme, keybindings);
		this.composition = new CompositionRenderer(options);
	}

	render(width: number): string[] {
		this.options.layout.reconcile(this);
		return this.composition.render(width, (contentWidth) => super.render(contentWidth));
	}
}

function decorate(editor: EditorComponent, options: PiCustomEditorOptions): EditorComponent {
	if (editor instanceof PiCustomEditor) return editor;
	const renderer = new CompositionRenderer(options);
	const renderNative = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		options.layout.reconcile(editor);
		return renderer.render(width, renderNative);
	};
	return editor;
}

export function installCustomEditor(
	ctx: ExtensionContext,
	state: TuiState,
	getThinkingLabel: () => string | undefined,
	onTuiAvailable: (tui: TUI) => void = () => {},
): () => void {
	const layouts = new Map<object, EditorMinimumRowsLease>();
	const removeLayer = installEditorLayer(ctx.ui, EDITOR_LAYER, (previous) => (tui, editorTheme, keybindings) => {
		onTuiAvailable(tui);
		let layout = layouts.get(tui as object);
		if (!layout) {
			layout = installEditorMinimumRows(tui, 1);
			layouts.set(tui as object, layout);
		}
		const options: PiCustomEditorOptions = { ctx, theme: ctx.ui.theme, state, getThinkingLabel, layout };
		const editor = previous?.(tui, editorTheme, keybindings);
		return editor ? decorate(editor, options) : new PiCustomEditor(tui, editorTheme, keybindings, options);
	});
	return () => {
		removeLayer();
		for (const layout of layouts.values()) layout.dispose();
		layouts.clear();
	};
}
