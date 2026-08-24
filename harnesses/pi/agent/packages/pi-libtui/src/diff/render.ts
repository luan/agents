import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { TOOL_SURFACE_BACKGROUND } from "../background-surface.ts";
import type { TuiBackgroundToken, TuiColor, TuiForegroundColor, TuiForegroundPaint, TuiTheme } from "../color/theme.ts";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import { icon } from "../decoration/glyphs.ts";
import type { SyntaxHighlightSpan } from "../syntax.ts";
import type { UnifiedDiffLine, UnifiedDiffLineKind, UnifiedDiffModel } from "./model.ts";
import { diffSyntax } from "./pierre-syntax.ts";

/** Explicit bounded row policy selected by a tool-owned view mode. */
export interface UnifiedDiffViewport {
	readonly maxRows: number;
	readonly selection?: "head" | "tail" | "head-tail";
}

export interface RenderUnifiedDiffOptions {
	readonly width: number;
	readonly theme: TuiTheme;
	readonly viewport?: UnifiedDiffViewport;
	/** Absolute render escape hatch, applied after wrapping. */
	readonly maxRenderedRows?: number;
	/** Paint the renderer-owned omission row with its semantic hover variant. */
	readonly omissionRowHovered?: boolean;
	/** Background for context, metadata, and hunk rows. Defaults to the shared tool surface. */
	readonly surface?: TuiBackgroundToken;
}

export interface UnifiedDiffRenderResult {
	readonly lines: readonly string[];
	readonly omittedRows: number;
	readonly truncated: boolean;
	/** Rendered row containing the omission fold, when the result is truncated. */
	readonly omissionRow?: number;
}

const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_VIEWPORT_ROWS = 120;
const DEFAULT_MAX_RENDERED_ROWS = 4_000;
const RENDER_CACHE_LIMIT = 16;
const renderCache = new Map<string, UnifiedDiffRenderResult>();
const themeIds = new WeakMap<TuiTheme, number>();
let nextThemeId = 1;

/** Render a parsed diff with full-row semantic paint and bounded work. */
export function renderUnifiedDiff(model: UnifiedDiffModel, options: RenderUnifiedDiffOptions): UnifiedDiffRenderResult {
	const width = Math.max(1, Math.floor(options.width));
	const viewport = normalizeDiffViewport(options.viewport);
	const rowBudget = viewport.maxRows;
	const maxRenderedRows = positiveInteger(options.maxRenderedRows, DEFAULT_MAX_RENDERED_ROWS);
	const syntax = diffSyntax(model);
	const cacheKey = `${model.revision}:${syntax.highlighted}:${themeId(options.theme)}:${width}:${viewport.selection}:${rowBudget}:${maxRenderedRows}:${options.surface ?? TOOL_SURFACE_BACKGROUND}:${options.omissionRowHovered === true}`;
	const cached = renderCache.get(cacheKey);
	if (cached) return touch(renderCache, cacheKey, cached);

	const logical = logicalRows(model);
	const selected = selectRows(logical, rowBudget, viewport.selection);
	const numberWidth = Math.max(1, digitWidth(model));
	const rendered: string[] = [];
	let omissionRow: number | undefined;
	let hardLimited = false;
	for (let index = 0; index < selected.rows.length && rendered.length < maxRenderedRows; index += 1) {
		const row = selected.rows[index]!;
		if (row.kind === "fold") {
			omissionRow ??= rendered.length;
			rendered.push(renderFoldRow(row, options, width, numberWidth));
			continue;
		}
		const remainingRows = maxRenderedRows - rendered.length;
		const remainingSelectedRows = selected.rows.length - index - 1;
		// Preserve one terminal row for every selected source row after this one.
		// Otherwise one wrapped line can consume the omission control and tail.
		const rowLimit = Math.max(1, remainingRows - remainingSelectedRows);
		const physicalLines = renderLogicalRow(
			row,
			syntax.lines,
			width,
			numberWidth,
			options.theme,
			options.surface ?? TOOL_SURFACE_BACKGROUND,
			rowLimit,
		);
		if (row.kind === "line" && row.line.text.length > rowLimit * width * 4) hardLimited = true;
		for (const [physicalIndex, line] of physicalLines.entries()) {
			if (rendered.length >= maxRenderedRows) {
				hardLimited = true;
				break;
			}
			rendered.push(line);
			if (
				rendered.length >= maxRenderedRows &&
				(physicalIndex < physicalLines.length - 1 || index < selected.rows.length - 1)
			)
				hardLimited = true;
		}
	}
	if (hardLimited && omissionRow === undefined && rendered.length > 0) {
		omissionRow = rendered.length - 1;
		rendered[omissionRow] = renderFoldRow(
			{ kind: "fold", count: 1, context: "… wrapped diff omitted …" },
			options,
			width,
			numberWidth,
		);
	}
	const hardOmitted = hardLimited ? 1 : Math.max(0, selected.estimatedRenderedRows - rendered.length);
	const omittedRows = selected.omittedRows + hardOmitted;
	const result: UnifiedDiffRenderResult = Object.freeze({
		lines: Object.freeze(rendered),
		omittedRows,
		truncated: model.truncated || omittedRows > 0,
		omissionRow,
	});
	return boundedSet(renderCache, cacheKey, result, RENDER_CACHE_LIMIT);
}

function renderFoldRow(
	row: Extract<LogicalRow, { kind: "fold" }>,
	options: RenderUnifiedDiffOptions,
	width: number,
	numberWidth: number,
): string {
	const hovered = options.omissionRowHovered === true;
	const gutterBackground = hovered ? "diff.hunkGutterHover" : "diff.hunkGutter";
	const sample = row.sample
		? ` ${options.theme.fg(
				row.sample.kind === "added"
					? { hue: "green", shade: 3 }
					: row.sample.kind === "removed"
						? { hue: "red", shade: 3 }
						: "text.secondary",
				row.sample.text,
			)}`
		: "";
	return paintDiffRow(options.theme, {
		background: hovered ? "diff.hunkHover" : "diff.hunk",
		foreground: options.theme.contrastBackground(options.theme.color(hovered ? "diff.hunkHover" : "diff.hunk")),
		gutter: gutterIcon(icon("fold-unfold")),
		content: `${row.context}${sample}`,
		width,
		numberWidth,
		gutterBackground,
		gutterForeground: "text.muted",
		gutterColor: options.theme.contrastBackground(options.theme.color(gutterBackground)),
	});
}

type LogicalRow =
	| { readonly kind: "header"; readonly text: string; readonly ref: string; readonly path?: string }
	| {
			readonly kind: "hunk";
			readonly text: string;
			readonly ref: string;
			readonly path?: string;
	  }
	| { readonly kind: "line"; readonly line: UnifiedDiffLine; readonly path?: string }
	/** A folded context span. It is not a hunk; the label is nearby diff context. */
	| {
			readonly kind: "fold";
			readonly count: number;
			readonly context: string;
			readonly sample?: { readonly kind: UnifiedDiffLineKind; readonly text: string };
	  };

function logicalRows(model: UnifiedDiffModel): LogicalRow[] {
	const rows: LogicalRow[] = model.preamble.map((text, index) => ({ kind: "header", text, ref: `p${index}` }));
	for (const file of model.files) {
		const path = file.newPath ?? file.oldPath;
		for (const [index, text] of file.headerLines.entries()) {
			if (isNullFileHeader(text)) continue;
			rows.push({ kind: "header", text, ref: `${file.ref}:m${index}`, path });
		}
		for (const hunk of file.hunks) {
			if (hunk.header.trim()) rows.push({ kind: "hunk", text: hunk.header, ref: hunk.ref, path });
			for (const line of hunk.lines) rows.push({ kind: "line", line, path });
		}
	}
	return rows;
}

function isNullFileHeader(text: string): boolean {
	return /^(?:---|\+\+\+)\s+\/dev\/null(?:\s|$)/u.test(text);
}

function selectRows(
	rows: readonly LogicalRow[],
	budget: number,
	selection: Required<UnifiedDiffViewport>["selection"],
): { rows: readonly LogicalRow[]; omittedRows: number; estimatedRenderedRows: number } {
	if (rows.length <= budget) return { rows, omittedRows: 0, estimatedRenderedRows: rows.length };
	const omittedRows = rows.length - budget;
	if (selection === "tail") {
		return {
			rows: [foldRow(rows, 0, rows.length - budget), ...rows.slice(-budget)],
			omittedRows,
			estimatedRenderedRows: budget + 1,
		};
	}
	if (selection === "head") {
		return {
			rows: [...rows.slice(0, budget), foldRow(rows, budget, rows.length)],
			omittedRows,
			estimatedRenderedRows: budget + 1,
		};
	}
	const head = Math.ceil(budget / 2);
	const tail = Math.floor(budget / 2);
	return {
		rows: [...rows.slice(0, head), foldRow(rows, head, rows.length - tail), ...rows.slice(rows.length - tail)],
		omittedRows,
		estimatedRenderedRows: budget + 1,
	};
}

function foldRow(rows: readonly LogicalRow[], start: number, end: number): Extract<LogicalRow, { kind: "fold" }> {
	const omittedHunk = rows
		.slice(start, end)
		.find((row): row is Extract<LogicalRow, { kind: "hunk" }> => row.kind === "hunk");
	const precedingHunk = omittedHunk
		? undefined
		: [...rows.slice(0, start)]
				.reverse()
				.find((row): row is Extract<LogicalRow, { kind: "hunk" }> => row.kind === "hunk");
	const followingHunk =
		omittedHunk || precedingHunk
			? undefined
			: rows.slice(end).find((row): row is Extract<LogicalRow, { kind: "hunk" }> => row.kind === "hunk");
	const contextHeader = omittedHunk?.text ?? precedingHunk?.text ?? followingHunk?.text;
	const contextLine = rows
		.slice(start, end)
		.find((row): row is Extract<LogicalRow, { kind: "line" }> => row.kind === "line")?.line;
	const count = Math.max(0, end - start);
	return {
		kind: "fold",
		count,
		context: contextHeader ?? `… ${count} rows omitted …`,
		sample: contextLine ? { kind: contextLine.kind, text: contextLine.text } : undefined,
	};
}

function normalizeDiffViewport(viewport: UnifiedDiffViewport | undefined): Required<UnifiedDiffViewport> {
	const requested = viewport?.maxRows ?? DEFAULT_VIEWPORT_ROWS;
	return {
		maxRows: Number.isFinite(requested)
			? Math.min(DEFAULT_MAX_ROWS, Math.max(1, Math.floor(requested)))
			: DEFAULT_VIEWPORT_ROWS,
		selection: viewport?.selection ?? "head-tail",
	};
}

function renderLogicalRow(
	row: Exclude<LogicalRow, { kind: "fold" }>,
	syntax: ReadonlyMap<string, readonly SyntaxHighlightSpan[]>,
	width: number,
	numberWidth: number,
	theme: TuiTheme,
	surface: TuiBackgroundToken,
	maxRows: number,
): string[] {
	if (row.kind === "header") return [paintFullRow(theme, surface, "text.secondary", row.text, width)];
	if (row.kind === "hunk") {
		return [
			paintDiffRow(theme, {
				background: "diff.hunk",
				foreground: theme.contrastBackground(theme.color("diff.hunk")),
				gutter: gutterIcon(icon("diff-hunk")),
				content: row.text,
				width,
				numberWidth,
				gutterBackground: "diff.hunkGutter",
				gutterForeground: "text.muted",
				gutterColor: theme.contrastBackground(theme.color("diff.hunkGutter")),
			}),
		];
	}
	const line = row.line;
	const lineNumber = line.kind === "removed" ? line.oldLine : (line.newLine ?? line.oldLine);
	const rail = line.kind === "added" ? "┃" : line.kind === "removed" ? "┋" : line.kind === "malformed" ? "!" : " ";
	const gutter = `${rail} ${formatLineNumber(lineNumber, numberWidth)} `;
	const contentWidth = Math.max(1, width - visibleWidth(gutter));
	const wrapped = wrapPlain(line.text, contentWidth, maxRows);
	const background: TuiBackgroundToken =
		line.kind === "added" ? "diff.added" : line.kind === "removed" ? "diff.removed" : surface;
	const gutterBackground: TuiBackgroundToken =
		line.kind === "added" ? "diff.addedGutter" : line.kind === "removed" ? "diff.removedGutter" : surface;
	const foreground =
		line.kind === "added"
			? "positive"
			: line.kind === "removed"
				? "negative"
				: line.kind === "malformed"
					? "warning"
					: "text.primary";
	const highlighted = syntax.get(line.ref);
	// Line numbers share the changed-row background, so the positive/negative
	// foregrounds used by the code and rail can disappear on light themes.
	// Keep the rails semantic, but use the theme's primary text for the number
	// lane so it remains readable against both dark and light diff surfaces.
	const lineNumberColor: TuiForegroundColor = line.kind === "context" ? "text.muted" : "text.primary";
	let sourceOffset = 0;
	return wrapped.map((text, wrappedIndex) => {
		const railColor: TuiForegroundColor =
			line.kind === "added"
				? "positive"
				: line.kind === "removed"
					? "negative"
					: line.kind === "malformed"
						? "warning"
						: "text.muted";
		const prefix =
			wrappedIndex === 0
				? `${theme.fg(railColor, rail)} ${theme.fg(lineNumberColor, formatLineNumber(lineNumber, numberWidth))} `
				: `${theme.fg(railColor, rail)} ${" ".repeat(numberWidth)} `;
		const spans = styleSyntaxSpans(
			text,
			sliceSyntaxSpans(highlighted, sourceOffset, sourceOffset + text.length),
			theme,
			foreground,
			background,
			line.kind,
		);
		sourceOffset += text.length;
		return paintDiffRow(theme, {
			background,
			gutterBackground,
			foreground,
			gutter: prefix,
			content: spans,
			width,
			numberWidth,
		});
	});
}

function styleSyntaxSpans(
	text: string,
	spans: readonly SyntaxHighlightSpan[] | undefined,
	theme: TuiTheme,
	fallback: TuiForegroundColor,
	lineBackground: TuiBackgroundToken,
	kind: UnifiedDiffLineKind,
): string {
	if (!spans || spans.length === 0) return theme.fg(fallback, text);
	const sanitized = spans.map((span) => ({ ...span, text: sanitizeTuiText(span.text) }));
	if (sanitized.map((span) => span.text).join("") !== text) return theme.fg(fallback, text);
	let output = "";
	for (const span of sanitized) {
		const painted = theme.fg(span.foreground ?? fallback, span.text);
		if (span.emphasized && (kind === "added" || kind === "removed")) {
			const emphasis = kind === "added" ? "diff.addedEmphasis" : "diff.removedEmphasis";
			output += `${theme.bgAnsi(emphasis)}${painted}${theme.bgAnsi(lineBackground)}`;
		} else output += painted;
	}
	return output;
}

function sliceSyntaxSpans(
	spans: readonly SyntaxHighlightSpan[] | undefined,
	start: number,
	end: number,
): readonly SyntaxHighlightSpan[] | undefined {
	if (!spans) return undefined;
	const sliced: SyntaxHighlightSpan[] = [];
	let offset = 0;
	for (const span of spans) {
		const spanStart = offset;
		const spanEnd = spanStart + span.text.length;
		if (spanStart < end && spanEnd > start) {
			sliced.push({
				...span,
				text: span.text.slice(Math.max(0, start - spanStart), Math.min(span.text.length, end - spanStart)),
			});
		}
		offset = spanEnd;
		if (offset >= end) break;
	}
	return sliced;
}

function paintFullRow(
	theme: TuiTheme,
	background: TuiBackgroundToken,
	foreground: TuiForegroundColor,
	content: string,
	width: number,
): string {
	const clipped = truncateToWidth(content, width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return `${theme.bgAnsi(background)}${theme.fgAnsi(foreground)}${clipped}${padding}\x1b[0m`;
}

function gutterIcon(glyph: string): string {
	// Hunk rows reserve the same leading cells as changed-line numbers, but do
	// not claim an add/remove rail. The glyph therefore starts in the leading
	// number column, aligned with the first digit of adjacent rows.
	return `  ${glyph}`;
}

interface DiffRowPaintOptions {
	readonly background: TuiBackgroundToken;
	readonly gutterBackground: TuiBackgroundToken;
	readonly foreground: TuiForegroundPaint;
	readonly gutter: string;
	readonly content: string;
	readonly width: number;
	readonly numberWidth: number;
	readonly gutterForeground?: TuiForegroundColor;
	readonly gutterColor?: TuiColor;
}

function paintDiffRow(theme: TuiTheme, options: DiffRowPaintOptions): string {
	const {
		background,
		gutterBackground,
		foreground,
		gutter,
		content,
		width,
		numberWidth,
		gutterForeground,
		gutterColor,
	} = options;
	const boundedWidth = Math.max(0, Math.floor(width));
	if (boundedWidth === 0) return "";
	const gutterWidth = Math.min(Math.max(1, numberWidth + 3), boundedWidth);
	const clippedGutter = truncateToWidth(gutter, gutterWidth, "");
	const gutterPadding = " ".repeat(Math.max(0, gutterWidth - visibleWidth(clippedGutter)));
	const contentWidth = Math.max(0, boundedWidth - gutterWidth);
	const clippedContent = truncateToWidth(content, contentWidth, "");
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clippedContent)));
	const gutterText = `${clippedGutter}${gutterPadding}`;
	const paintedGutter = gutterColor
		? theme.fg(gutterColor, gutterText)
		: gutterForeground
			? `${theme.fgAnsi(gutterForeground)}${gutterText}`
			: gutterText;
	return `${theme.bgAnsi(gutterBackground)}${paintedGutter}${theme.bgAnsi(background)}${theme.fgAnsi(foreground)}${clippedContent}${padding}\x1b[0m`;
}

function wrapPlain(text: string, width: number, maxRows: number): string[] {
	const clean = sanitizeTuiText(text)
		.replaceAll("\t", "    ")
		.slice(0, Math.max(1, width) * Math.max(1, maxRows) * 4);
	if (clean.length === 0) return [""];
	const rows: string[] = [];
	let remaining = clean;
	while (remaining.length > 0 && rows.length < maxRows) {
		const part = truncateToWidth(remaining, width, "");
		if (part.length === 0) {
			// A wide glyph cannot fit a one-column viewport. Drop it rather than loop forever.
			remaining = [...remaining].slice(1).join("");
			continue;
		}
		rows.push(part);
		remaining = remaining.slice(part.length);
	}
	return rows.length === 0 ? [""] : rows;
}

function digitWidth(model: UnifiedDiffModel): number {
	let maximum = 0;
	for (const file of model.files) {
		for (const hunk of file.hunks) {
			maximum = Math.max(
				maximum,
				hunk.oldStart === undefined ? 0 : hunk.oldStart + Math.max(0, (hunk.oldCount ?? 1) - 1),
				hunk.newStart === undefined ? 0 : hunk.newStart + Math.max(0, (hunk.newCount ?? 1) - 1),
			);
			for (const line of hunk.lines) maximum = Math.max(maximum, line.oldLine ?? 0, line.newLine ?? 0);
		}
	}
	return String(maximum).length;
}

function formatLineNumber(value: number | undefined, width: number): string {
	return value === undefined ? " ".repeat(width) : String(value).padStart(width);
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

function themeId(theme: TuiTheme): number {
	const existing = themeIds.get(theme);
	if (existing !== undefined) return existing;
	const id = nextThemeId++;
	themeIds.set(theme, id);
	return id;
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V): V {
	cache.delete(key);
	cache.set(key, value);
	return value;
}

function boundedSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
	cache.set(key, value);
	while (cache.size > limit) {
		const oldest = cache.keys().next().value as K | undefined;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return value;
}
