import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { type EditorFactory, type EditorUi, installEditorLayer, removeEditorLayer } from "../shared/tui";
import { colorizeHandles, handleSpans } from "./handles";

const EDITOR_LAYER_ID = Symbol.for("imageAttach.editorHandleLayer");

type TextSegment = { segment: string; index: number; input: string };
type SegmentFn = (text: string, mode: "grapheme" | "word") => Iterable<TextSegment>;

type LayeredEditor = EditorComponent & {
	transformEditorLine?: (line: string) => string;
	/**
	 * pi's own grapheme/word segmenter. Private to the class, but the editor routes every cursor
	 * move, delete, and wrap through it, so wrapping it is what makes a handle behave as one unit.
	 */
	segment?: SegmentFn;
	getCursor?: () => { line: number; col: number };
	getLines?: () => string[];
	setCursorCol?: (col: number) => void;
	moveWordBackwards?: () => void;
	moveWordForwards?: () => void;
};

/**
 * Collapse each handle's graphemes into a single segment, the way pi already does for its own
 * `[paste #N]` markers. Deletion removes one segment, so a handle goes whole rather than leaving
 * `ge #1]` behind, and left/right step over it.
 */
export function mergeHandleSegments(text: string, base: Iterable<TextSegment>): Iterable<TextSegment> {
	const spans = handleSpans(text);
	if (spans.length === 0) return base;

	const merged: TextSegment[] = [];
	for (const item of base) {
		const span = spans.find((candidate) => item.index >= candidate.start && item.index < candidate.end);
		if (!span) {
			merged.push(item);
		} else if (item.index === span.start) {
			merged.push({ segment: text.slice(span.start, span.end), index: span.start, input: text });
		}
	}
	return merged;
}

function cursorLine(editor: LayeredEditor): string {
	const cursor = editor.getCursor?.();
	return cursor ? (editor.getLines?.()[cursor.line] ?? "") : "";
}

/**
 * Stop a word motion at the near edge of a handle it starts against. The word walker only knows
 * pi's own markers are atomic (`isAtomicSegment: isPasteMarker` inside the editor), so without
 * this a ctrl+w next to a handle would take the handle *and* the word before it.
 */
function installWordMotionSnap(editor: LayeredEditor): void {
	const setCursorCol = editor.setCursorCol?.bind(editor);
	const moveBackwards = editor.moveWordBackwards?.bind(editor);
	const moveForwards = editor.moveWordForwards?.bind(editor);
	if (!setCursorCol) return;

	if (moveBackwards) {
		editor.moveWordBackwards = () => {
			const from = editor.getCursor?.().col ?? 0;
			const span = handleSpans(cursorLine(editor)).find((candidate) => candidate.end === from);
			moveBackwards();
			if (span && (editor.getCursor?.().col ?? 0) < span.start) setCursorCol(span.start);
		};
	}
	if (moveForwards) {
		editor.moveWordForwards = () => {
			const from = editor.getCursor?.().col ?? 0;
			const span = handleSpans(cursorLine(editor)).find((candidate) => candidate.start === from);
			moveForwards();
			if (span && (editor.getCursor?.().col ?? 0) > span.end) setCursorCol(span.end);
		};
	}
}

function wrapEditorFactory(previous: EditorFactory | undefined): EditorFactory {
	return (tui, theme, keybindings) => {
		const editor = (previous?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as LayeredEditor;
		const previousRender = editor.render.bind(editor);
		const previousTransform = editor.transformEditorLine?.bind(editor);
		const previousSegment = editor.segment?.bind(editor);
		let usedLineTransform = false;

		// Absent only if pi renames the method; handles then stay editable character by character.
		if (previousSegment) {
			editor.segment = (text, mode) => mergeHandleSegments(text, previousSegment(text, mode));
		}
		installWordMotionSnap(editor);

		editor.transformEditorLine = (line: string) => {
			usedLineTransform = true;
			return colorizeHandles(previousTransform?.(line) ?? line);
		};
		editor.render = (width: number) => {
			usedLineTransform = false;
			const rendered = previousRender(width);
			// The border rows are not content, so only fall back to whole-frame tinting when the
			// host never asked for a per-line transform.
			return usedLineTransform ? rendered : rendered.map((line) => colorizeHandles(line));
		};
		return editor;
	};
}

export function installEditorHandleHighlight(ui: EditorUi): void {
	installEditorLayer(ui, EDITOR_LAYER_ID, wrapEditorFactory);
}
export function removeEditorHandleHighlight(ui: EditorUi): void {
	removeEditorLayer(ui, EDITOR_LAYER_ID);
}
