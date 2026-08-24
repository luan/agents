import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	decodeKittyPrintable,
	isKeyRelease,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { mountSelectionActionBar, TransientPill } from "pi-libtui";
import { ensureFoldingRegistry, type FoldingRegistry, type FoldOperation, foldTargetAt } from "pi-libtui/folding";
import { ensureMouseRegistry, type MouseRegistry, type TuiMouseEvent } from "pi-libtui/mouse";
import type { NativeSelectionCompleted, SelectionQuoteAnchor, SelectionShape } from "pi-libtui/selection";
import { ensureSelectionRegistry, type SelectionPoint, type SelectionRegistry } from "pi-libtui/selection";
import {
	type CopyModeAction,
	type CopyModeKeybindings,
	loadCopyModeKeybindings,
	matchCopyModeAction,
} from "../config/keybindings.ts";
import { getCopyModeSettings } from "../config/settings.ts";
import {
	type CursorDocument,
	type CursorMotion,
	type CursorPoint,
	clampCursor,
	graphemeEnd,
	moveCursor,
	moveVirtualCursor,
	scrollTopForCursor,
} from "../core/cursor.ts";
import {
	type CharMotion,
	findCharMotionTarget,
	findFirstNonblank,
	findParagraphMotionTarget,
	findWordMotionTarget,
	type LastCharMotion,
	type LazyTextDocument,
	reverseCharMotion,
	VimMotionCache,
} from "../core/vim-motions.ts";
import { decorateCopyCursor, decorateCopyScreen } from "../ui/screen-decoration.ts";
import { type FullscreenSurface, validateFullscreenSurface } from "./fullscreen-surface.ts";

const STATUS_KEY = "pi-copy-mode.active";
const TARGET_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_COUNT = 9_999;
const FOLD_ACTIONS = [
	"copy-mode.foldOpen",
	"copy-mode.foldClose",
	"copy-mode.foldOpenAll",
	"copy-mode.foldCloseAll",
] as const;
type SelectionKind = "cursor" | "character" | "line" | "column";
type CopySelectionPayload = NativeSelectionCompleted & {
	text: string;
	shape: SelectionShape;
	screenAnchor: SelectionPoint;
	source: { quote: SelectionQuoteAnchor; offsets?: { start: number; end: number } };
};

const MOTIONS: Partial<Record<CopyModeAction, CursorMotion>> = {
	"copy-mode.up": "up",
	"copy-mode.down": "down",
	"copy-mode.left": "left",
	"copy-mode.right": "right",
	"copy-mode.lineStart": "line-start",
	"copy-mode.lineEnd": "line-end",
	"copy-mode.top": "document-start",
	"copy-mode.bottom": "document-end",
	"copy-mode.halfPageUp": "half-page-up",
	"copy-mode.halfPageDown": "half-page-down",
	"copy-mode.pageUp": "page-up",
	"copy-mode.pageDown": "page-down",
};

export interface CopyModeHost {
	enter(adoptSelection?: boolean): boolean;
	selectionCompleted(selection: NativeSelectionCompleted): void;
	dispose(): void;
	readonly active: boolean;
	readonly cursor: CursorPoint;
}

export interface CopyModeHostOptions {
	bindings?: CopyModeKeybindings;
	registry?: MouseRegistry;
	selection?: SelectionRegistry;
	copyOnSelect?: boolean;
}

export function createCopyModeHost(tui: TUI, ctx: ExtensionContext, options: CopyModeHostOptions = {}): CopyModeHost {
	let modeActive = false;
	let selectionKind: SelectionKind = "cursor";
	let disposed = false;
	let cursor: CursorPoint = { row: 0, col: 0 };
	let anchor: CursorPoint = cursor;
	let preferredCol = 0;
	let removeFallbackInput: (() => void) | undefined;
	let removeViewportInput: (() => void) | undefined;
	let reinstallModalInput: (() => void) | undefined;
	let interactionPending = false;
	let suppressFallbackData: string | undefined;
	let removeScreenDecorator: (() => void) | undefined;
	let removeCursorDecorator: (() => void) | undefined;
	let removeMouseRegion: (() => void) | undefined;
	let removeSelectionModeInput: (() => void) | undefined;
	let completedSelection: NativeSelectionCompleted | undefined;
	let selectionMode = false;
	let exitAfterInteraction = false;
	let activeInput: ((data: string) => { consume: true } | undefined) | undefined;
	let countDigits = "";
	let pendingChar: { motion: CharMotion; count: number } | undefined;
	let lastChar: LastCharMotion | undefined;
	let pendingFoldPrefix = false;
	const vimMotions = new VimMotionCache();
	const registry = options.registry ?? ensureMouseRegistry();
	const selection = options.selection ?? ensureSelectionRegistry();
	const folding: FoldingRegistry = ensureFoldingRegistry();
	const removeNativeCopyDeferrer = registry.registerNativeCopyDeferrer(
		() => !disposed && surface() !== undefined && !(options.copyOnSelect ?? getCopyModeSettings().copyOnSelect),
	);
	const bindings = options.bindings ?? loadCopyModeKeybindings();
	const feedbackPill = new TransientPill({
		theme: ctx.ui.theme,
		requestRender: () => surface()?.requestImmediateRender(),
	});
	const actionBar = mountSelectionActionBar({
		registry,
		id: "pi-copy-mode.selection-actions",
		theme: ctx.ui.theme,
		actions: [
			{ value: "comment", label: "comment", icon: "comment", shortcuts: bindings["copy-mode.annotate"] },
			{ value: "reaction", label: "react", icon: "reaction", shortcuts: bindings["copy-mode.react"] },
			{ value: "copy", label: "copy", icon: "copy", shortcuts: bindings["copy-mode.copy"] },
		],
		requestRender: () => surface()?.requestImmediateRender(),
		onActivate: activateSelectionBarAction,
		isHidden: () => tui.hasOverlay(),
		getTarget(context) {
			const activeSurface = surface();
			const activeSelection =
				modeActive && selectionKind !== "cursor" && activeSurface ? selectionFor(activeSurface) : context.selection;
			if (
				!activeSelection ||
				(!modeActive && (!completedSelection || !sameLogicalSelection(activeSelection, completedSelection)))
			) {
				return undefined;
			}
			// Pi's live context exposes geometry only; completedSelection retains the
			// normalized text for the native-selection path.
			const selectedText =
				"text" in activeSelection && typeof activeSelection.text === "string"
					? activeSelection.text
					: completedSelection?.text;
			return {
				selection: activeSelection.screen,
				...(selectedText !== undefined ? { selectedText } : {}),
			};
		},
	});
	const motionActions = new Set<CopyModeAction>([
		...(Object.keys(MOTIONS) as CopyModeAction[]),
		"copy-mode.wordForward",
		"copy-mode.wordEnd",
		"copy-mode.wordBackward",
		"copy-mode.bigWordForward",
		"copy-mode.bigWordEnd",
		"copy-mode.bigWordBackward",
		"copy-mode.findForward",
		"copy-mode.findBackward",
		"copy-mode.tillForward",
		"copy-mode.tillBackward",
		"copy-mode.repeatFind",
		"copy-mode.reverseFind",
		"copy-mode.paragraphForward",
		"copy-mode.paragraphBackward",
		"copy-mode.firstNonblank",
		"copy-mode.firstNonblankDown",
	]);
	const selectionActions = new Set<CopyModeAction>(["copy-mode.annotate", "copy-mode.react"]);
	const selectionModeActions = new Set<CopyModeAction>([...selectionActions, "copy-mode.copy"]);

	function surface(): FullscreenSurface | undefined {
		return validateFullscreenSurface(tui);
	}

	function hasNativeSelection(activeSurface: FullscreenSurface): boolean {
		const nativeAnchor = activeSurface.selectionAnchor;
		const nativeFocus = activeSurface.selectionFocus;
		return (
			nativeAnchor !== undefined &&
			nativeFocus !== undefined &&
			(nativeAnchor.row !== nativeFocus.row || nativeAnchor.col !== nativeFocus.col)
		);
	}

	function sameLogicalSelection(
		left: Pick<NativeSelectionCompleted, "logical">,
		right: Pick<NativeSelectionCompleted, "logical">,
	): boolean {
		return (
			left.logical.start.row === right.logical.start.row &&
			left.logical.start.col === right.logical.start.col &&
			left.logical.end.row === right.logical.end.row &&
			left.logical.end.col === right.logical.end.col
		);
	}

	function activateSelectionBarAction(value: "comment" | "reaction" | "copy"): void {
		if (!modeActive) {
			selectionMode = false;
			if (!enter(true)) return;
			if (value !== "copy") exitAfterInteraction = true;
		}
		const action =
			value === "comment" ? "copy-mode.annotate" : value === "reaction" ? "copy-mode.react" : "copy-mode.copy";
		handleAction(action);
	}

	const removeFeedbackDecorator = registry.registerScreenDecorator({
		id: "pi-copy-mode.feedback",
		priority: -10,
		decorate(screen, context) {
			if (context.hasOverlay || tui.hasOverlay()) return screen;
			return feedbackPill.composite(screen, {
				width: context.width,
				height: context.height,
				viewport: context.viewport,
			});
		},
	});

	function document(activeSurface: FullscreenSurface): CursorDocument {
		return {
			lineCount: activeSurface.lineCount,
			lineWidth: (row) => activeSurface.lineWidth(row),
			lineStops: (row) => activeSurface.lineStops(row),
			viewportHeight: activeSurface.viewportHeight,
		};
	}

	function status(): string {
		const base = selectionKind === "cursor" ? "COPY MODE" : `COPY MODE · ${selectionKind}`;
		if (pendingChar) return `${base} · ${pendingChar.count > 1 ? pendingChar.count : ""}${pendingChar.motion}`;
		return countDigits ? `${base} · ${countDigits}` : base;
	}

	function textDocument(activeSurface: FullscreenSurface): LazyTextDocument {
		return { lineCount: activeSurface.lineCount, line: (row) => stripTerminalSequences(activeSurface.line(row)) };
	}

	function columnBounds(activeSurface: FullscreenSurface): {
		top: number;
		bottom: number;
		left: number;
		right: number;
	} {
		return {
			top: Math.min(anchor.row, cursor.row),
			bottom: Math.max(anchor.row, cursor.row),
			left: Math.min(anchor.col, cursor.col),
			right: Math.max(
				anchor.col + 1,
				cursor.col + 1,
				graphemeEnd(anchor, document(activeSurface)),
				graphemeEnd(cursor, document(activeSurface)),
			),
		};
	}

	function columnText(activeSurface: FullscreenSurface): string {
		const bounds = columnBounds(activeSurface);
		const width = bounds.right - bounds.left;
		return Array.from({ length: bounds.bottom - bounds.top + 1 }, (_unused, index) =>
			activeSurface.line(bounds.top + index),
		)
			.map((line) => {
				const selected = stripTerminalSequences(sliceByColumn(line, bounds.left, width, true));
				return selected + " ".repeat(Math.max(0, width - visibleWidth(selected)));
			})
			.join("\n");
	}

	function lineText(activeSurface: FullscreenSurface): string {
		const top = Math.min(anchor.row, cursor.row);
		const bottom = Math.max(anchor.row, cursor.row);
		return `${Array.from({ length: bottom - top + 1 }, (_unused, index) => stripTerminalSequences(activeSurface.line(top + index))).join("\n")}\n`;
	}

	function characterText(activeSurface: FullscreenSurface, trimRows = true): string {
		const renderedAnchor = activeSurface.selectionAnchor ?? activeSurface.point(anchor);
		const renderedFocus = activeSurface.selectionFocus ?? activeSurface.point(cursor);
		const anchorFirst =
			renderedAnchor.row < renderedFocus.row ||
			(renderedAnchor.row === renderedFocus.row && renderedAnchor.col <= renderedFocus.col);
		const start = anchorFirst ? renderedAnchor : renderedFocus;
		const end = anchorFirst ? renderedFocus : renderedAnchor;
		return Array.from({ length: end.row - start.row + 1 }, (_unused, index) => {
			const row = start.row + index;
			const from = row === start.row ? start.col : 0;
			const to =
				row === end.row
					? end.boundary === true
						? end.col
						: graphemeEnd({ row, col: end.col }, document(activeSurface))
					: activeSurface.lineWidth(row);
			const selected = stripTerminalSequences(
				sliceByColumn(activeSurface.line(row), from, Math.max(0, to - from), true),
			);
			return trimRows ? selected.trimEnd() : selected;
		}).join("\n");
	}

	function sourceOffset(activeSurface: FullscreenSurface, point: CursorPoint): number {
		let offset = 0;
		for (let row = 0; row < point.row; row += 1) offset += stripTerminalSequences(activeSurface.line(row)).length + 1;
		return offset + stripTerminalSequences(sliceByColumn(activeSurface.line(point.row), 0, point.col, true)).length;
	}

	function sourceQuote(activeSurface: FullscreenSurface, start: CursorPoint, exact: string): SelectionQuoteAnchor {
		const context = 80;
		const source = Array.from({ length: activeSurface.lineCount }, (_, row) =>
			stripTerminalSequences(activeSurface.line(row)),
		).join("\n");
		const offset = sourceOffset(activeSurface, start);
		if (source.slice(offset, offset + exact.length) !== exact) return { exact };
		return {
			exact,
			...(offset > 0 ? { prefix: source.slice(Math.max(0, offset - context), offset) } : {}),
			...(offset + exact.length < source.length
				? { suffix: source.slice(offset + exact.length, offset + exact.length + context) }
				: {}),
		};
	}

	function selectionFor(activeSurface: FullscreenSurface): CopySelectionPayload {
		if (selectionKind === "column") {
			const bounds = columnBounds(activeSurface);
			const start = { row: bounds.top, col: bounds.left };
			const end = { row: bounds.bottom, col: bounds.right };
			const text = columnText(activeSurface);
			return {
				text,
				shape: "column",
				screenAnchor: activeSurface.screenPoint(end),
				logical: { start, end },
				screen: { start: activeSurface.screenPoint(start), end: activeSurface.screenPoint(end) },
				source: { quote: { exact: text } },
			};
		}
		if (selectionKind === "line") {
			const top = Math.min(anchor.row, cursor.row);
			const bottom = Math.max(anchor.row, cursor.row);
			const start = { row: top, col: 0 };
			const end = { row: bottom, col: activeSurface.lineGlyphWidth(bottom) };
			const text = lineText(activeSurface);
			const lineEnd = bottom + 1 < activeSurface.lineCount ? { row: bottom + 1, col: 0 } : end;
			return {
				text,
				shape: "line",
				screenAnchor: activeSurface.screenPoint({ row: bottom, col: activeSurface.lineGlyphWidth(bottom) }),
				logical: { start, end },
				screen: {
					start: activeSurface.screenPoint(start),
					end: activeSurface.screenPoint({ row: bottom, col: activeSurface.lineGlyphWidth(bottom) }),
				},
				source: {
					...(bottom + 1 < activeSurface.lineCount
						? { offsets: { start: sourceOffset(activeSurface, start), end: sourceOffset(activeSurface, lineEnd) } }
						: {}),
					quote: sourceQuote(activeSurface, start, text),
				},
			};
		}
		if (selectionKind === "cursor") {
			const start = { ...cursor };
			const end = { row: cursor.row, col: graphemeEnd(cursor, document(activeSurface)) };
			const text = characterText(activeSurface);
			return {
				text,
				shape: "character",
				screenAnchor: activeSurface.screenPoint(end),
				logical: { start, end },
				screen: { start: activeSurface.screenPoint(start), end: activeSurface.screenPoint(end) },
				source: {
					offsets: { start: sourceOffset(activeSurface, start), end: sourceOffset(activeSurface, end) },
					quote: sourceQuote(activeSurface, start, text),
				},
			};
		}
		const renderedAnchor = activeSurface.selectionAnchor ?? activeSurface.point(anchor);
		const renderedFocus = activeSurface.selectionFocus ?? activeSurface.point(cursor);
		const anchorPoint = { row: renderedAnchor.row, col: renderedAnchor.col };
		const focusPoint = { row: renderedFocus.row, col: renderedFocus.col };
		const first =
			anchorPoint.row < focusPoint.row || (anchorPoint.row === focusPoint.row && anchorPoint.col <= focusPoint.col)
				? anchorPoint
				: focusPoint;
		const last = first === anchorPoint ? focusPoint : anchorPoint;
		const renderedLast = first === anchorPoint ? renderedFocus : renderedAnchor;
		const logical = { start: { ...first }, end: { ...last } };
		const text = characterText(activeSurface);
		const characterEnd = {
			row: last.row,
			col: renderedLast.boundary === true ? last.col : graphemeEnd(last, document(activeSurface)),
		};
		const offsets = { start: sourceOffset(activeSurface, first), end: sourceOffset(activeSurface, characterEnd) };
		const offsetsAreExact = characterText(activeSurface, false) === text;
		return {
			text,
			shape: "character",
			screenAnchor: activeSurface.screenPoint(characterEnd),
			logical,
			screen: { start: activeSurface.screenPoint(first), end: activeSurface.screenPoint(characterEnd) },
			source: { ...(offsetsAreExact ? { offsets } : {}), quote: sourceQuote(activeSurface, first, text) },
		};
	}

	function applySelection(activeSurface: FullscreenSurface): void {
		const end = graphemeEnd(cursor, document(activeSurface));
		if (selectionKind === "column" || selectionKind === "cursor" || selectionKind === "line") {
			activeSurface.setSelection(undefined, undefined);
		} else if (anchor.row === cursor.row && anchor.col === cursor.col) {
			activeSurface.setSelection(activeSurface.point(anchor), activeSurface.point({ ...cursor, col: end }, true));
		} else {
			activeSurface.setSelection(activeSurface.point(anchor), activeSurface.point(cursor));
		}
		activeSurface.requestImmediateRender();
	}

	function cursorFromScreen(activeSurface: FullscreenSurface, event: TuiMouseEvent): CursorPoint | undefined {
		const viewport = activeSurface.viewportRect;
		if (
			event.screenRow < viewport.y ||
			event.screenRow >= viewport.y + viewport.height ||
			event.screenCol < viewport.x ||
			event.screenCol >= viewport.x + viewport.width ||
			activeSurface.lineCount === 0
		)
			return undefined;
		const row = Math.max(
			0,
			Math.min(activeSurface.lineCount - 1, event.screenRow - viewport.y + activeSurface.scrollTop),
		);
		const target = Math.max(0, Math.min(activeSurface.lineWidth(row), event.screenCol - viewport.x));
		const stops = activeSurface.lineStops(row);
		let col = stops[0] ?? 0;
		for (const stop of stops) {
			if (stop > target) break;
			col = stop;
		}
		return { row, col };
	}

	function removeModalInput(): void {
		removeViewportInput?.();
		removeViewportInput = undefined;
		removeFallbackInput?.();
		removeFallbackInput = undefined;
		suppressFallbackData = undefined;
	}

	async function requestSelectionAction(action: string, activeSurface: FullscreenSurface): Promise<void> {
		if (interactionPending) return;
		interactionPending = true;
		const leaveAfterInteraction = exitAfterInteraction;
		exitAfterInteraction = false;
		removeModalInput();
		try {
			const payload = selectionFor(activeSurface);
			const confirmed = await selection.publishSelectionAction({
				...payload,
				action,
				showFeedback(feedback) {
					feedbackPill.show(
						{
							label: feedback.message,
							icon: feedback.kind === "warning" ? "warning" : "confirm",
							tone: feedback.kind === "warning" ? "warning" : "positive",
						},
						payload.screenAnchor,
					);
				},
			});
			if (leaveAfterInteraction && modeActive && !disposed) {
				exit(true);
				return;
			}
			if (confirmed && modeActive && !disposed) {
				const currentSurface = surface();
				if (currentSurface) {
					selectionKind = "cursor";
					anchor = cursor;
					ctx.ui.setStatus(STATUS_KEY, status());
					applySelection(currentSurface);
				}
			}
		} finally {
			interactionPending = false;
			if (modeActive && !disposed) reinstallModalInput?.();
		}
	}

	async function copyCurrentSelection(activeSurface: FullscreenSurface): Promise<void> {
		const anchorPoint = activeSurface.screenPoint(cursor);
		const text =
			selectionKind === "column"
				? columnText(activeSurface)
				: selectionKind === "line"
					? lineText(activeSurface)
					: characterText(activeSurface);
		const copying = activeSurface.copyText(text);
		exit(true);
		const copied = await copying;
		feedbackPill.show(
			{
				label: copied ? "Copied!" : "Copy failed",
				icon: copied ? "copy" : "warning",
				tone: copied ? "info" : "warning",
			},
			anchorPoint,
		);
	}

	function exit(clearSelection: boolean): void {
		if (!modeActive) return;
		modeActive = false;
		selectionMode = false;
		selectionKind = "cursor";
		actionBar.invalidate();
		if (clearSelection) completedSelection = undefined;
		countDigits = "";
		pendingChar = undefined;
		pendingFoldPrefix = false;
		removeScreenDecorator?.();
		removeScreenDecorator = undefined;
		removeCursorDecorator?.();
		removeCursorDecorator = undefined;
		removeMouseRegion?.();
		removeMouseRegion = undefined;
		removeModalInput();
		activeInput = undefined;
		reinstallModalInput = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		const activeSurface = surface();
		if (clearSelection && activeSurface) {
			activeSurface.setSelection(undefined, undefined);
			activeSurface.requestImmediateRender();
		}
	}

	function commitCursor(activeSurface: FullscreenSurface, next: CursorPoint, updatePreferred = true): void {
		cursor = selectionKind === "column" ? next : clampCursor(next, document(activeSurface));
		if (updatePreferred) preferredCol = cursor.col;
		const nextTop = scrollTopForCursor(cursor, activeSurface.scrollTop, activeSurface.viewportHeight);
		if (nextTop !== activeSurface.scrollTop) activeSurface.scrollTo(nextTop);
		applySelection(activeSurface);
	}

	function executeCharMotion(
		activeSurface: FullscreenSurface,
		motion: CharMotion,
		target: string,
		count: number,
		repeat: boolean,
		remember = true,
	): void {
		const next = findCharMotionTarget(textDocument(activeSurface), vimMotions, cursor, motion, target, repeat, count);
		if (!next) return;
		if (remember) lastChar = { motion, char: target };
		commitCursor(activeSurface, next);
	}

	function applyFold(operation: FoldOperation, activeSurface: FullscreenSurface): void {
		if (operation.endsWith("-all")) {
			folding.apply(operation);
		} else {
			const point = activeSurface.componentAt(cursor.row);
			const target = point ? foldTargetAt(point.component, point.row) : undefined;
			folding.apply(operation, target && folding.has(target) ? target : null);
		}
		activeSurface.requestImmediateRender();
	}

	function handleAction(action: CopyModeAction, count = 1): void {
		count = Number.isFinite(count) ? Math.max(1, Math.min(MAX_COUNT, Math.trunc(count))) : 1;
		const activeSurface = surface();
		if (!activeSurface) {
			exit(false);
			return;
		}
		const motion = MOTIONS[action];
		if (motion) {
			if (
				selectionKind !== "column" &&
				[
					"up",
					"down",
					"half-page-up",
					"half-page-down",
					"page-up",
					"page-down",
					"document-start",
					"document-end",
				].includes(motion)
			) {
				const page = Math.max(1, activeSurface.viewportHeight);
				const halfPage = Math.max(1, Math.floor(page / 2));
				const row =
					motion === "up"
						? cursor.row - count
						: motion === "down"
							? cursor.row + count
							: motion === "half-page-up"
								? cursor.row - halfPage * count
								: motion === "half-page-down"
									? cursor.row + halfPage * count
									: motion === "page-up"
										? cursor.row - page * count
										: motion === "page-down"
											? cursor.row + page * count
											: motion === "document-start"
												? 0
												: activeSurface.lineCount - 1;
				commitCursor(activeSurface, { row, col: preferredCol }, false);
				return;
			}
			let next = cursor;
			for (let index = 0; index < count; index += 1) {
				next =
					selectionKind === "column"
						? moveVirtualCursor(next, motion, {
								lineCount: activeSurface.lineCount,
								viewportHeight: activeSurface.viewportHeight,
								maxColumn: Math.max(0, activeSurface.viewportRect.width - 1),
							})
						: moveCursor(next, motion, document(activeSurface));
			}
			commitCursor(activeSurface, next);
			return;
		}
		const text = textDocument(activeSurface);
		const wordActions: Partial<Record<CopyModeAction, ["forward" | "backward", "start" | "end", "word" | "WORD"]>> = {
			"copy-mode.wordForward": ["forward", "start", "word"],
			"copy-mode.wordEnd": ["forward", "end", "word"],
			"copy-mode.wordBackward": ["backward", "start", "word"],
			"copy-mode.bigWordForward": ["forward", "start", "WORD"],
			"copy-mode.bigWordEnd": ["forward", "end", "WORD"],
			"copy-mode.bigWordBackward": ["backward", "start", "WORD"],
		};
		const word = wordActions[action];
		if (word) {
			commitCursor(activeSurface, findWordMotionTarget(text, vimMotions, cursor, word[0], word[1], word[2], count));
			return;
		}
		switch (action) {
			case "copy-mode.findForward":
				pendingChar = { motion: "f", count };
				ctx.ui.setStatus(STATUS_KEY, status());
				break;
			case "copy-mode.findBackward":
				pendingChar = { motion: "F", count };
				ctx.ui.setStatus(STATUS_KEY, status());
				break;
			case "copy-mode.tillForward":
				pendingChar = { motion: "t", count };
				ctx.ui.setStatus(STATUS_KEY, status());
				break;
			case "copy-mode.tillBackward":
				pendingChar = { motion: "T", count };
				ctx.ui.setStatus(STATUS_KEY, status());
				break;
			case "copy-mode.repeatFind":
				if (lastChar) executeCharMotion(activeSurface, lastChar.motion, lastChar.char, count, true, false);
				break;
			case "copy-mode.reverseFind":
				if (lastChar)
					executeCharMotion(activeSurface, reverseCharMotion(lastChar.motion), lastChar.char, count, true, false);
				break;
			case "copy-mode.paragraphForward":
				commitCursor(activeSurface, findParagraphMotionTarget(text, cursor.row, "forward", count));
				break;
			case "copy-mode.paragraphBackward":
				commitCursor(activeSurface, findParagraphMotionTarget(text, cursor.row, "backward", count));
				break;
			case "copy-mode.firstNonblank":
				commitCursor(activeSurface, { row: cursor.row, col: findFirstNonblank(text, vimMotions, cursor.row) });
				break;
			case "copy-mode.firstNonblankDown": {
				const row = Math.min(activeSurface.lineCount - 1, cursor.row + count - 1);
				commitCursor(activeSurface, { row, col: findFirstNonblank(text, vimMotions, row) });
				break;
			}
			case "copy-mode.toggleSelection":
				if (selectionKind === "cursor") {
					selectionKind = "character";
					anchor = cursor;
				} else if (selectionKind === "character") {
					selectionKind = "cursor";
					anchor = cursor;
				} else selectionKind = "character";
				ctx.ui.setStatus(STATUS_KEY, status());
				applySelection(activeSurface);
				break;
			case "copy-mode.lineSelection":
				if (selectionKind === "cursor") {
					selectionKind = "line";
					anchor = cursor;
				} else if (selectionKind === "line") {
					selectionKind = "cursor";
					anchor = cursor;
				} else selectionKind = "line";
				ctx.ui.setStatus(STATUS_KEY, status());
				applySelection(activeSurface);
				break;
			case "copy-mode.columnSelection":
				if (selectionKind === "cursor") {
					selectionKind = "column";
					anchor = cursor;
				} else if (selectionKind === "column") {
					selectionKind = "cursor";
					anchor = cursor;
				} else selectionKind = "column";
				ctx.ui.setStatus(STATUS_KEY, status());
				applySelection(activeSurface);
				break;
			case "copy-mode.swapEnds": {
				if (selectionKind === "cursor") break;
				const previousAnchor = anchor;
				anchor = cursor;
				cursor = previousAnchor;
				preferredCol = cursor.col;
				const nextTop = scrollTopForCursor(cursor, activeSurface.scrollTop, activeSurface.viewportHeight);
				if (nextTop !== activeSurface.scrollTop) activeSurface.scrollTo(nextTop);
				applySelection(activeSurface);
				break;
			}
			case "copy-mode.clearSelection":
				selectionKind = "cursor";
				anchor = cursor;
				ctx.ui.setStatus(STATUS_KEY, "COPY MODE");
				applySelection(activeSurface);
				break;
			case "copy-mode.copy":
				void copyCurrentSelection(activeSurface);
				break;
			case "copy-mode.annotate":
				void requestSelectionAction("selection.comment", activeSurface);
				break;
			case "copy-mode.react":
				void requestSelectionAction("selection.reaction", activeSurface);
				break;
			case "copy-mode.cancel":
				exit(true);
				break;
			case "copy-mode.foldOpen":
				applyFold("open", activeSurface);
				break;
			case "copy-mode.foldClose":
				applyFold("close", activeSurface);
				break;
			case "copy-mode.foldOpenAll":
				applyFold("open-all", activeSurface);
				break;
			case "copy-mode.foldCloseAll":
				applyFold("close-all", activeSurface);
				break;
		}
	}

	function enter(adoptSelection = false): boolean {
		if (disposed) return false;
		const activeSurface = surface();
		if (!activeSurface) {
			ctx.ui.notify("Copy mode requires Pi's fullscreen TUI.", "warning");
			return false;
		}
		if (adoptSelection && !hasNativeSelection(activeSurface)) {
			// Native selection can be cleared after completion; never turn a stale
			// selection-mode key into an action on the copy cursor.
			selectionMode = false;
			completedSelection = undefined;
			return false;
		}
		if (modeActive && adoptSelection && activeSurface.selectionAnchor && activeSurface.selectionFocus) {
			countDigits = "";
			pendingChar = undefined;
			pendingFoldPrefix = false;
			anchor = { row: activeSurface.selectionAnchor.row, col: activeSurface.selectionAnchor.col };
			cursor = clampCursor(
				{ row: activeSurface.selectionFocus.row, col: activeSurface.selectionFocus.col },
				document(activeSurface),
			);
			preferredCol = cursor.col;
			selectionKind = "character";
			ctx.ui.setStatus(STATUS_KEY, status());
			activeSurface.requestImmediateRender();
			return true;
		}
		if (modeActive) return true;
		if (adoptSelection && activeSurface.selectionAnchor && activeSurface.selectionFocus) {
			anchor = { row: activeSurface.selectionAnchor.row, col: activeSurface.selectionAnchor.col };
			cursor = clampCursor(
				{ row: activeSurface.selectionFocus.row, col: activeSurface.selectionFocus.col },
				document(activeSurface),
			);
			preferredCol = cursor.col;
			selectionKind = "character";
		} else {
			const bottom = Math.min(activeSurface.lineCount - 1, activeSurface.scrollTop + activeSurface.viewportHeight - 1);
			cursor = clampCursor({ row: Math.max(0, bottom), col: 0 }, document(activeSurface));
			preferredCol = cursor.col;
			anchor = cursor;
			selectionKind = "cursor";
		}
		modeActive = true;
		ctx.ui.setStatus(STATUS_KEY, status());
		removeScreenDecorator = registry.registerScreenDecorator({
			id: "pi-copy-mode.active",
			// Paint selection backgrounds before annotation components rebuild
			// their badges and handles.
			priority: 100,
			decorate(screen, context) {
				if (!modeActive) return screen;
				if (context.hasOverlay || tui.hasOverlay()) return screen;
				const nextSurface = surface();
				return nextSurface
					? decorateCopyScreen(screen, nextSurface, { kind: selectionKind, anchor, cursor }, ctx.ui.theme)
					: screen;
			},
		});
		removeCursorDecorator = registry.registerScreenDecorator({
			id: "pi-copy-mode.cursor",
			// The cursor must be the final transcript paint so inline badges
			// cannot hide it when they are rebuilt after selection paint.
			priority: 10,
			decorate(screen, context) {
				if (!modeActive || context.hasOverlay || tui.hasOverlay()) return screen;
				const nextSurface = surface();
				return nextSurface
					? decorateCopyCursor(screen, nextSurface, { kind: selectionKind, anchor, cursor }, ctx.ui.theme)
					: screen;
			},
		});
		removeMouseRegion = registry.registerOverlayRegion({
			id: "pi-copy-mode.cursor",
			priority: 100,
			getRect: () => surface()?.viewportRect,
			onMouse(event) {
				if (!modeActive || event.type !== "press" || (event.button !== undefined && event.button !== 0)) return false;
				const activeSurface = surface();
				const next = activeSurface ? cursorFromScreen(activeSurface, event) : undefined;
				if (!activeSurface || !next) return false;
				pendingChar = undefined;
				countDigits = "";
				selectionKind = "cursor";
				anchor = next;
				commitCursor(activeSurface, next);
				ctx.ui.setStatus(STATUS_KEY, status());
				// Let Pi receive this press so a following drag remains native selection.
				return false;
			},
		});
		if (adoptSelection) activeSurface.requestImmediateRender();
		else applySelection(activeSurface);
		const handleModalInput = (data: string): { consume: true } | undefined => {
			if (!modeActive || isKeyRelease(data) || tui.hasOverlay()) return undefined;
			// Some terminal/input bridges deliver a short printable sequence as one
			// chunk. Preserve Vim fold chords in that case instead of treating `zc`
			// as an unknown printable command.
			const foldPrefix =
				data.length === 2 ? bindings["copy-mode.foldPrefix"]?.find((key) => matchesKey(data[0]!, key)) : undefined;
			if (
				!pendingFoldPrefix &&
				foldPrefix &&
				data.length === 2 &&
				/^[\x20-\x7e]{2}$/u.test(data) &&
				matchesKey(data[0]!, foldPrefix)
			) {
				pendingFoldPrefix = true;
				return handleModalInput(data[1]!);
			}
			const action = matchesKey(data, "ctrl+[")
				? matchCopyModeAction("\x1b", bindings)
				: matchCopyModeAction(data, bindings);
			if (pendingFoldPrefix) {
				pendingFoldPrefix = false;
				const foldAction = FOLD_ACTIONS.find((candidate) => bindings[candidate]?.some((key) => matchesKey(data, key)));
				if (foldAction) {
					handleAction(foldAction);
					ctx.ui.setStatus(STATUS_KEY, status());
					return { consume: true };
				}
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (action === "copy-mode.foldPrefix") {
				pendingFoldPrefix = true;
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (action && FOLD_ACTIONS.some((candidate) => candidate === action)) {
				// Fold suffixes are scoped to the configured prefix. They are not
				// package-owned standalone shortcuts.
				countDigits = "";
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (action === "copy-mode.clearSelection" && (pendingChar || countDigits)) {
				pendingChar = undefined;
				countDigits = "";
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			const decoded = decodeKittyPrintable(data);
			const printable = decoded ?? (/^[^\x00-\x1f\x7f]+$/u.test(data) ? data : undefined);
			if (pendingChar && printable) {
				const pending = pendingChar;
				pendingChar = undefined;
				const activeSurface = surface();
				const target = [...TARGET_SEGMENTER.segment(printable)][0]?.segment;
				if (activeSurface && target) executeCharMotion(activeSurface, pending.motion, target, pending.count, false);
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (pendingChar) {
				pendingChar = undefined;
				countDigits = "";
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (printable && /^\d$/u.test(printable) && (printable !== "0" || countDigits.length > 0)) {
				countDigits = String(Math.min(MAX_COUNT, Number.parseInt(`${countDigits}${printable}`, 10)));
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			if (!action) {
				countDigits = "";
				ctx.ui.setStatus(STATUS_KEY, status());
				return { consume: true };
			}
			const count = countDigits ? Math.min(MAX_COUNT, Number.parseInt(countDigits, 10)) : 1;
			countDigits = "";
			handleAction(action, count);
			if (modeActive && !pendingChar) ctx.ui.setStatus(STATUS_KEY, status());
			return { consume: true };
		};
		activeInput = handleModalInput;
		reinstallModalInput = () => {
			if (!modeActive || disposed || removeViewportInput || removeFallbackInput) return;
			removeViewportInput = registry.registerViewportInputHandler({
				id: "pi-copy-mode.active",
				priority: 1_000,
				handle(data) {
					const result = handleModalInput(data);
					if (result?.consume) {
						suppressFallbackData = data;
						queueMicrotask(() => {
							if (suppressFallbackData === data) suppressFallbackData = undefined;
						});
					}
					return result;
				},
			});
			removeFallbackInput = ctx.ui.onTerminalInput((data) => {
				if (suppressFallbackData === data) {
					suppressFallbackData = undefined;
					return { consume: true };
				}
				return handleModalInput(data);
			});
		};
		reinstallModalInput();
		return true;
	}

	removeSelectionModeInput = registry.registerViewportInputHandler({
		id: "pi-copy-mode.selection-mode",
		priority: 1_100,
		handle(data) {
			if (!selectionMode || modeActive || isKeyRelease(data)) return undefined;
			const action = matchCopyModeAction(data, bindings);
			if (!action || (!motionActions.has(action) && !selectionModeActions.has(action))) return undefined;
			if (action === "copy-mode.halfPageDown" && matchesKey(data, "ctrl+d")) return undefined;
			selectionMode = false;
			if (!enter(true)) return undefined;
			if (selectionActions.has(action)) exitAfterInteraction = true;
			return activeInput?.(data);
		},
	});

	return {
		enter,
		selectionCompleted(next) {
			completedSelection = next;
			if (!disposed && !modeActive) selectionMode = true;
			surface()?.requestImmediateRender();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			exit(true);
			removeSelectionModeInput?.();
			removeSelectionModeInput = undefined;
			actionBar.dispose();
			feedbackPill.dispose();
			removeFeedbackDecorator();
			removeNativeCopyDeferrer();
		},
		get active() {
			return modeActive;
		},
		get cursor() {
			return cursor;
		},
	};
}
