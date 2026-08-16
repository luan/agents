// Nested calls have no Pi row. This module asks the presentation registry for each tool view and stacks the returned components.

import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { isExplorationHidden } from "../shared/exploration-rendering.ts";
import { KittyVirtualImage } from "../shared/kitty-virtual-image.ts";
import { approxTokenCount, formatTokenCost, formatTokenCount } from "../shared/output-budget.ts";
import { getToolPresentation } from "../shared/tool-registry.ts";
import { detachToolResultImages } from "../shared/tool-result-images.ts";
import { type CardTheme, framedBlock, styledSymbol } from "../shared/tui/card.ts";
import {
	EmptyComponent,
	italic,
	paintTokenCost,
	renderTokenCost,
	rgbFg,
	runningCellElapsedMs,
	runningFrame,
	scaleRgb,
	themeRoleAnsi,
	themeRoleToRgb,
} from "../shared/tui/index.ts";
import { splitCellPayload } from "./payload.ts";
import {
	type CellLanguage,
	countEchoed,
	echoedLines,
	MAX_PREVIEW_CHARS,
	type NestedCallRecord,
	nestedCallResult,
	settledCallCount,
} from "./runtime.ts";

const COLLAPSED_OUTPUT_LINES = 3;
const EXPANDED_OUTPUT_LINES = 12;
const EXPANDED_CODE_LINES = 40;
const LANGUAGE_ICON_SCALE = 0.55;

export interface CellRenderParams {
	code?: string;
	language?: CellLanguage;
	cell_id?: number;
}

export interface CellRenderDetails extends CellRenderParams {
	status?: string;
	durationMs?: number;
	artifactUri?: string;
	outputTokens?: number;
	calls?: NestedCallRecord[];
	errorCallId?: string;
	/** Persisted because live nested results do not survive a reload. */
	serializedNestedResult?: boolean;
	serializedNestedResultNotice?: string;
	/** Echoed-line count measured while the results were live, because `liveResults` (runtime.ts:40) is a WeakMap that a replayed row misses. */
	copiedLines?: number;
	sessionId?: string;
}

// `summary` crosses from the result renderer to the call renderer, which pi runs first, so it is read one pass late.
interface CellRenderState {
	summary?: CellRenderDetails;
	startedAtMs?: number;
	replayed?: boolean;
	resyncTimer?: ReturnType<typeof setTimeout>;
	nested?: Map<number, NestedSlot>;
	echoed?: { key: string; lines: ReadonlySet<string> };
	images?: EmittedImage[];
}

interface EmittedImage {
	data: string;
	mimeType: string;
}

interface NestedSlot {
	state: Record<string, unknown>;
	call?: Component;
	result?: Component;
}

interface CellRenderContext {
	args?: CellRenderParams;
	toolCallId?: string;
	invalidate?: () => void;
	state?: CellRenderState;
	cwd?: string;
	isPartial?: boolean;
	argsComplete?: boolean;
	executionStarted?: boolean;
	expanded?: boolean;
	isError?: boolean;
	sessionId?: string;
}

interface NestedRow {
	call: NestedCallRecord;
	components: ReadonlyArray<Component>;
	/** Built only when `components` draw nothing, so a tool whose card already drew never runs its result renderer twice. */
	replay?: () => ReadonlyArray<Component>;
	replayed?: ReadonlyArray<Component>;
	/** Settled nested rows do not change until the parent renderer replaces this stack. */
	rendered?: { width: number; lines: string[] };
	fallback?: string;
	/** Resolved against whether the card drew: `drew` rows already show what the preview repeats. */
	status: (drew: boolean) => string | undefined;
}

interface NestedRowsPart {
	rows: ReadonlyArray<NestedRow>;
	header: (label: string, rows: ReadonlyArray<NestedRow>) => string;
	theme: CardTheme;
}

type CellStackPart =
	| string
	| { indent: number; components: ReadonlyArray<Component>; fallback?: string }
	| NestedRowsPart;

class CellStack implements Component {
	constructor(private readonly parts: ReadonlyArray<CellStackPart>) {}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const part of this.parts) {
			if (typeof part === "string") {
				lines.push(part);
				continue;
			}
			if ("rows" in part) {
				appendNestedRows(part, width, lines);
				continue;
			}
			const rendered = part.components.flatMap((component) => component.render(width));
			if (rendered.some((line) => line.trim().length > 0)) {
				for (const line of rendered) lines.push(line);
			} else if (part.fallback) {
				lines.push(`${" ".repeat(part.indent)}${part.fallback}`);
			}
		}
		return lines;
	}

	invalidate(): void {
		for (const part of this.parts) {
			if (typeof part === "string") continue;
			if ("rows" in part) {
				for (const row of part.rows) {
					row.rendered = undefined;
					for (const c of row.components) c.invalidate();
					for (const c of row.replayed ?? []) c.invalidate();
				}
				continue;
			}
			for (const c of part.components) c.invalidate();
		}
	}
}

const NESTED_ROW_INDENT = 2;
const GROUP_MIN_ROWS = 2;
const TREE_LAST = "└─";
const TREE_BRANCH = "├─";
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TRAILING_PADDING_PATTERN = /[ \t]+((?:\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*)$/;
const LEADING_MARKER_PATTERN = /^[^\p{L}\p{N}]+/u;

/**
 * A row's lines, or none.
 *
 * `render` runs outside the try/catch that built the component, and pi's `updateDisplay` guard never sees a nested
 * row, so a throw here reached `uncaughtException` and killed the session:
 * `TypeError: Cannot read properties of undefined (reading 'length')` at exec-cell-rendering-internal.ts:266.
 */
function safeRender(components: ReadonlyArray<Component>, width: number): string[] {
	const lines: string[] = [];
	for (const component of components) {
		try {
			lines.push(...component.render(width));
		} catch {
			return [];
		}
	}
	return lines;
}

function nestedRowLines(row: NestedRow, width: number): string[] {
	if (row.call.status !== "running" && row.rendered?.width === width) return row.rendered.lines;
	const rendered = safeRender(row.components, width);
	let drew = rendered.some((line) => line.trim().length > 0);
	let drawn = drew ? rendered : [];
	if (!drew && row.replay) {
		try {
			row.replayed ??= row.replay();
		} catch {
			row.replayed = [];
		}
		const replayed = safeRender(row.replayed, width);
		drew = replayed.some((line) => line.trim().length > 0);
		if (drew) drawn = replayed;
	}
	if (!drew && row.fallback) drawn = [`${" ".repeat(NESTED_ROW_INDENT)}${row.fallback}`];
	const status = row.status(drew);
	if (status) drawn.push(status);
	if (row.call.status !== "running") row.rendered = { width, lines: drawn };
	return drawn;
}

function groupLabel(header: string): string {
	const plain = header.replace(ANSI_PATTERN, "");
	const meta = plain.indexOf(" · ");
	return (meta === -1 ? plain : plain.slice(0, meta)).replace(LEADING_MARKER_PATTERN, "").trim();
}

// Name plus the row's own title line: `read` draws a file summary, a `ResourceReadCardView` and an image preview, and only rows whose titles agree can share one header.
function groupKey(row: NestedRow, lines: ReadonlyArray<string>): string | undefined {
	if (row.call.name !== "read" || row.call.status !== "completed" || lines.length < 2) return undefined;
	const label = groupLabel(lines[0] ?? "");
	return label ? `${row.call.name} ${label}` : undefined;
}

function coalescedReadCalls(
	rows: ReadonlyArray<NestedRow>,
	at: number,
	lines: ReadonlyArray<string>,
): ReadonlyArray<NestedCallRecord> | undefined {
	const count = Number(/^Read \((\d+)\)$/.exec(groupLabel(lines[0] ?? ""))?.[1]);
	if (!Number.isInteger(count) || count < 2 || at + 1 < count || lines.length < count + 1) return undefined;
	const calls = rows.slice(at + 1 - count, at + 1).map((row) => row.call);
	return calls.every((call) => call.name === "read") ? calls : undefined;
}

// Every grouped row was drawn as a card of one, so `renderExplorationText` (shared/exploration-rendering.ts:420) closed it with the last-connector. Under a shared header only the final row ends the tree.
function branchConnector(line: string): string {
	return line.replace(TREE_LAST, TREE_BRANCH);
}

// `resultTokens` is measured once per call at execute time (runtime.ts:182), never here. Replayed calls from before that field existed stay explicit instead of looking free.
function callCost(call: NestedCallRecord, theme: CardTheme): string | undefined {
	if (call.status === "running") return undefined;
	const tokens = call.resultTokens;
	if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return theme.fg("warning", "cost unknown");
	return renderTokenCost(theme, tokens, call.name);
}

function middleTruncate(line: string, maxWidth: number): string {
	const totalWidth = visibleWidth(line);
	if (totalWidth <= maxWidth) return line;
	if (maxWidth <= 0) return "";
	const ellipsis = "\u2026";
	if (maxWidth === 1) return ellipsis;
	const contentWidth = maxWidth - 1;
	const headWidth = Math.ceil(contentWidth / 2);
	const tailWidth = contentWidth - headWidth;
	const hasLink = line.includes("\x1b]8;;");
	const closeLink = hasLink ? "\x1b]8;;\x1b\\" : "";
	return (
		sliceByColumn(line, 0, headWidth) +
		closeLink +
		ellipsis +
		sliceByColumn(line, totalWidth - tailWidth, tailWidth) +
		closeLink
	);
}

function withRowCost(line: string, call: NestedCallRecord, theme: CardTheme, width: number): string {
	const cost = callCost(call, theme);
	if (!cost) return line;
	const suffix = ` ${theme.fg("dim", "·")} ${cost}`;
	return middleTruncate(line.replace(TRAILING_PADDING_PATTERN, "$1"), width - visibleWidth(suffix)) + suffix;
}

function appendNestedRows(part: NestedRowsPart, width: number, out: string[]): void {
	const rendered = part.rows.map((row) => nestedRowLines(row, width));
	const keys = part.rows.map((row, index) => groupKey(row, rendered[index] ?? []));
	for (let at = 0; at < part.rows.length; ) {
		const key = keys[at];
		let end = at + 1;
		if (key !== undefined) while (end < keys.length && keys[end] === key) end += 1;
		if (key === undefined) {
			const lines = rendered[at] ?? [];
			const call = part.rows[at]?.call;
			const costLine = call?.name === "read" && lines.length > 0 ? Math.min(1, lines.length - 1) : -1;
			for (let line = 0; line < lines.length; line += 1) {
				out.push(
					line === costLine && call
						? withRowCost(lines[line] ?? "", call, part.theme, width)
						: (lines[line] ?? ""),
				);
			}
			at += 1;
			continue;
		}
		if (end - at < GROUP_MIN_ROWS) {
			const lines = rendered[at] ?? [];
			const coalescedCalls = coalescedReadCalls(part.rows, at, lines);
			for (let line = 0; line < lines.length; line += 1) {
				const text = lines[line] ?? "";
				const call = coalescedCalls?.[line - 1] ?? (line === 1 ? part.rows[at]?.call : undefined);
				out.push(call ? withRowCost(text, call, part.theme, width) : text);
			}
			at += 1;
			continue;
		}
		out.push(part.header(groupLabel(rendered[at]?.[0] ?? ""), part.rows.slice(at, end)));
		for (let index = at; index < end; index += 1) {
			const lines = rendered[index] ?? [];
			const call = part.rows[index]?.call;
			for (let line = 1; line < lines.length; line += 1) {
				let text = lines[line] ?? "";
				if (line === 1) {
					if (index < end - 1) text = branchConnector(text);
					if (call) text = withRowCost(text, call, part.theme, width);
				}
				out.push(text);
			}
		}
		at = end;
	}
}

function groupHeaderLine(label: string, rows: ReadonlyArray<NestedRow>, theme: CardTheme): string {
	const dot = styledSymbol(theme, "status.done", "accent");
	const known = rows.flatMap((row) => {
		const tokens = row.call.resultTokens;
		return tokens === undefined || !Number.isFinite(tokens) || tokens < 0 ? [] : [tokens];
	});
	const tokens = known.reduce((total, value) => total + value, 0);
	const unknown = rows.length - known.length;
	const parts = [`${dot} ${theme.fg("toolTitle", label)}`, theme.fg("dim", `(${rows.length})`)];
	if (known.length > 0) {
		const cost = formatTokenCost(tokens, rows[0]?.call.name);
		// formatTokenCount (output-budget.ts:262) rounds 10k+ to whole k; grouped rows keep one decimal for exact visible sums.
		const text = tokens >= 10_000 ? `${(tokens / 1_000).toFixed(1)}k tok` : cost.text;
		parts.push(theme.fg("dim", "·"), paintTokenCost(theme, cost.severity, text));
	} else parts.push(theme.fg("warning", "cost unknown"));
	if (unknown > 0) parts.push(theme.fg("warning", `+ ${unknown} cost${unknown === 1 ? "" : "s"} unknown`));
	return parts.join(" ");
}

/** Nerd Font marks U+E73C, U+E628, U+E781, named as codepoints because all three were once lost to a copy as empty strings. */
function languageIcon(language: CellLanguage): string {
	return language === "ts" ? "" : "";
}

function languageIconColor(language: CellLanguage): string {
	return language === "ts" ? "accent" : "warning";
}

function cellLanguage(language: CellLanguage | undefined): CellLanguage {
	return language ?? "ts";
}

function paintLanguageIcon(theme: CardTheme, language: CellLanguage): string {
	const icon = languageIcon(language);
	const role = languageIconColor(language);
	if (!themeRoleAnsi(theme, role)) return theme.fg("dim", icon);
	return `${rgbFg(scaleRgb(themeRoleToRgb(theme, role), LANGUAGE_ICON_SCALE))}${icon}\x1b[39m`;
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

const FALLBACK_SUBJECT_CHARS = 72;

function callSubject(args: unknown): string {
	if (typeof args === "string") return args;
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>);
	const subject = entries.find(([, value]) => typeof value === "string" && value.trim().length > 0)?.[1];
	const text = typeof subject === "string" ? subject : entries.length > 0 ? JSON.stringify(entries[0]?.[1]) : "";
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > FALLBACK_SUBJECT_CHARS ? `${flat.slice(0, FALLBACK_SUBJECT_CHARS)}…` : flat;
}

// `wait` takes only a `cell_id`, so its language and code come from the previous render. A streaming `code` still carries its pragma line.
function mergedParams(rawParams: unknown, state: CellRenderState | undefined): CellRenderDetails {
	const merged: CellRenderDetails = { ...state?.summary };
	if (rawParams && typeof rawParams === "object") {
		for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
			if (value === undefined) continue;
			if (key === "code" && typeof value === "string") {
				Object.assign(merged, splitCellPayload(value));
				continue;
			}
			(merged as Record<string, unknown>)[key] = value;
		}
	}
	return merged;
}

function codeLines(params: CellRenderDetails, theme: CardTheme): string[] {
	const code = typeof params.code === "string" ? params.code.replace(/\t/g, "  ") : "";
	if (!code) return [];
	const cell = cellLanguage(params.language);
	const language = cell === "ts" ? "typescript" : "javascript";
	const rows = code.split(/\r?\n/);
	// Sliced before the parse: an 804-row cell cost 10.32 ms a frame to highlight the 40 rows it shows, 0.49 ms after.
	const window = rows.slice(0, EXPANDED_CODE_LINES);
	let highlighted: string[];
	try {
		highlighted = highlightCode(window.join("\n"), language);
	} catch {
		highlighted = window;
	}
	const lines = highlighted.map((line) => `${theme.fg("dim", "│ ")}${line}`);
	const hidden = rows.length - window.length;
	if (hidden > 0) lines.push(`${theme.fg("dim", "│ ")}${theme.fg("muted", `… +${hidden} lines`)}`);
	return lines;
}

function cellPhrase(writing: boolean, running: boolean, toolCount: number): string {
	if (writing) return "Writing";
	if (running) return "Running tools via";
	return toolCount > 0 ? "Ran tools via" : "Ran code in";
}

function tokenSegment(params: CellRenderDetails, theme: CardTheme): string {
	const inTokens = typeof params.code === "string" ? approxTokenCount(params.code) : 0;
	const parts = inTokens > 0 ? [theme.fg("dim", `↑${formatTokenCount(inTokens)}`)] : [];
	if (params.outputTokens !== undefined) {
		const cost = formatTokenCost(params.outputTokens, "exec");
		parts.push(paintTokenCost(theme, cost.severity, `↓${cost.text}`));
	}
	return parts.join(" ");
}

function cellHeaderParts(
	rawParams: unknown,
	theme: CardTheme,
	context: CellRenderContext,
): { header: string; parts: CellStackPart[]; failed: boolean; running: boolean } {
	const params = mergedParams(rawParams, context.state);
	const writing = context.argsComplete === false && context.executionStarted !== true;
	const running = context.isPartial !== false || params.status === "running";
	const failed = context.isError === true || params.status === "error";
	const elapsedMs = runningCellElapsedMs(context.state, running);
	const toolCount = params.calls?.length ?? 0;
	const phrase = `${cellPhrase(writing, running, toolCount)} `;
	const spinner = running ? `${theme.fg("accent", runningFrame(elapsedMs))} ` : "";
	const lead = theme.fg("muted", italic(phrase));
	const icon = paintLanguageIcon(theme, cellLanguage(params.language));
	const separator = theme.fg("dim", " · ");
	const tokens = tokenSegment(params, theme);
	const duration = formatDuration(params.durationMs ?? (running ? elapsedMs : undefined));
	const meta = [
		failed ? theme.fg("error", "failed") : undefined,
		toolCount > 0 ? theme.fg("dim", `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`) : undefined,
		tokens || undefined,
		duration ? theme.fg("dim", duration) : undefined,
	].filter((part): part is string => Boolean(part));
	const title = `${lead}${icon}`;
	const header = `${spinner}${title}${meta.length > 0 ? `${separator}${meta.join(separator)}` : ""}`;
	return {
		header,
		parts: context.expanded === true ? codeLines(params, theme) : [],
		failed,
		running,
	};
}

export function renderCellCall(rawParams: unknown, theme: CardTheme, context: CellRenderContext): Component {
	const state = cellHeaderParts(rawParams, theme, context);
	if (!state.running) return new EmptyComponent();
	return framedBlock(theme, {
		header: state.header,
		sections: state.parts.length > 0 ? [{ component: new CellStack(state.parts) }] : [],
		borderColor: state.failed ? "error" : "borderMuted",
	});
}

function resync(context: CellRenderContext, params: CellRenderDetails): void {
	const state = context.state;
	if (!state) return;
	const previous = state.summary;
	state.summary = params;
	const settled =
		previous?.status === params.status &&
		previous?.durationMs === params.durationMs &&
		previous?.cell_id === params.cell_id;
	if (settled || state.resyncTimer || !context.invalidate) return;
	state.resyncTimer = setTimeout(() => {
		state.resyncTimer = undefined;
		context.invalidate?.();
	}, 0);
	state.resyncTimer.unref?.();
}

function nestedSlot(state: CellRenderState | undefined, index: number): NestedSlot {
	if (!state) return { state: {} };
	state.nested ??= new Map();
	const existing = state.nested.get(index);
	if (existing) return existing;
	const slot: NestedSlot = { state: {} };
	state.nested.set(index, slot);
	return slot;
}

function sessionIdFor(context: CellRenderContext): string | undefined {
	return context.sessionId ?? context.state?.summary?.sessionId;
}

function presentationFor(call: NestedCallRecord, context: CellRenderContext): ReturnType<typeof getToolPresentation> {
	const sessionId = sessionIdFor(context);
	return sessionId ? getToolPresentation(call.name, sessionId) : undefined;
}

// Grouped exploration cards intentionally hide all but their owning row. A fallback would draw those paths twice.
function nestedFallbackLine(call: NestedCallRecord, theme: CardTheme, context: CellRenderContext): string | undefined {
	if (isExplorationHidden(call.toolCallId) || presentationFor(call, context)?.emptyRenderIsFinal === true)
		return undefined;
	const dot = styledSymbol(theme, "status.done", call.status === "error" ? "error" : "accent");
	const subject = callSubject(call.args);
	const parts = [`${dot} ${theme.fg("toolTitle", call.name)}`];
	if (subject) parts.push(theme.fg("muted", subject));
	if (call.status === "running") {
		parts.push(theme.fg("dim", "·"), theme.fg("dim", "running"));
	} else {
		const cost = callCost(call, theme);
		if (cost) parts.push(theme.fg("dim", "·"), cost);
	}
	return parts.join(" ");
}

function nestedContext(
	call: NestedCallRecord,
	slot: NestedSlot,
	context: CellRenderContext,
	lastComponent: Component | undefined,
): unknown {
	return {
		args: call.args,
		toolCallId: call.toolCallId,
		invalidate: context.invalidate ?? (() => {}),
		lastComponent,
		state: slot.state,
		sessionId: sessionIdFor(context),
		executionStarted: true,
		// A thrown error has no result renderer. Keep the call renderer active so
		// tools that own their failure can draw the error card once.
		isPartial: call.status === "running" || (call.status === "error" && !nestedCallResult(call)),
		expanded: false,
		showImages: false,
		isError: call.status === "error",
		nestedDetails: nestedCallResult(call)?.details ?? call.details,
		nestedError: call.status === "error" ? call.preview : undefined,
	};
}

type NestedResultRenderer = (
	result: unknown,
	options: { expanded: boolean; isPartial: boolean },
	theme: CardTheme,
	context: unknown,
) => Component;

function renderNestedResult(
	renderResult: NestedResultRenderer | undefined,
	result: unknown,
	call: NestedCallRecord,
	slot: NestedSlot,
	theme: CardTheme,
	context: CellRenderContext,
): Component | undefined {
	if (!renderResult) return undefined;
	try {
		slot.result = renderResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			nestedContext(call, slot, context, slot.result),
		);
		return slot.result;
	} catch {
		slot.result = undefined;
		return undefined;
	}
}

// Reload drops liveResults. Persisted previews stay bounded and let each registered renderer recover its own card.
function replayResult(
	call: NestedCallRecord,
): { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> } | undefined {
	if (call.status === "running") return undefined;
	return {
		content: call.preview ? [{ type: "text", text: call.preview }] : [],
		...(!call.detailsClipped && call.details ? { details: call.details } : {}),
	};
}

// These renderers belong to other extensions and get a context they were never written against, so a throw costs one row, not the cell. Same catches as pi's `updateDisplay`.
function nestedComponents(
	call: NestedCallRecord,
	index: number,
	theme: CardTheme,
	context: CellRenderContext,
): Component[] {
	const definition = presentationFor(call, context);
	const slot = nestedSlot(context.state, index);
	const components: Component[] = [];

	const renderCall = definition?.renderCall as
		| ((args: unknown, theme: CardTheme, context: unknown) => Component)
		| undefined;
	if (renderCall) {
		try {
			slot.call = renderCall(call.args, theme, nestedContext(call, slot, context, slot.call));
			components.push(slot.call);
		} catch {
			slot.call = undefined;
		}
	}

	const result = nestedCallResult(call);
	const renderResult = definition?.renderResult as NestedResultRenderer | undefined;
	if (result) {
		const drawn = renderNestedResult(renderResult, result, call, slot, theme, context);
		if (drawn) components.push(drawn);
	}

	return components;
}

function nestedReplayComponents(
	call: NestedCallRecord,
	index: number,
	theme: CardTheme,
	context: CellRenderContext,
): Component[] {
	if (nestedCallResult(call)) return [];
	const result = replayResult(call);
	if (!result) return [];
	const renderResult = presentationFor(call, context)?.renderResult as NestedResultRenderer | undefined;
	const drawn = renderNestedResult(renderResult, result, call, nestedSlot(context.state, index), theme, context);
	return drawn ? [drawn] : [];
}

// `preview` (runtime.ts:130) repeats the result the card already drew, so a card that states its own failure keeps this row off. Opt-in, not inferred: a card that ignores `isError` — fileops read draws its normal path row — leaves this row as the only report of the error.
function previewIsRedundant(call: NestedCallRecord, drew: boolean, context: CellRenderContext): boolean {
	return drew && presentationFor(call, context)?.rendersOwnFailure === true;
}

function nestedStatusLine(
	call: NestedCallRecord,
	theme: CardTheme,
	expanded: boolean,
	elapsedMs: number | undefined,
	drew: boolean,
	context: CellRenderContext,
): string | undefined {
	if (call.status === "running") {
		if (drew || presentationFor(call, context)?.renderCall) return undefined;
		return [theme.fg("accent", runningFrame(elapsedMs)), theme.fg("dim", "running")].join(" ");
	}
	if (call.status === "error") {
		if (previewIsRedundant(call, drew, context)) return undefined;
		return `${styledSymbol(theme, "status.error", "error")} ${theme.fg("error", call.preview ?? "failed")}`;
	}
	if (!expanded) return undefined;
	const preview = previewIsRedundant(call, drew, context) ? undefined : call.preview;
	const meta = [formatDuration(call.durationMs), preview].filter(Boolean).join(" · ");
	return meta ? theme.fg("dim", meta) : undefined;
}

// Cached on the settled-call count: an earlier version re-indexed megabytes a repaint and held a session at 100% CPU.
function cachedEchoedLines(
	calls: ReadonlyArray<NestedCallRecord> | undefined,
	state: CellRenderState | undefined,
): ReadonlySet<string> {
	const key = `${calls?.length ?? 0}:${settledCallCount(calls)}`;
	if (state?.echoed?.key === key) return state.echoed.lines;
	const lines = echoedLines(calls);
	if (state) state.echoed = { key, lines };
	return lines;
}

const RESIDUE_MIN_PRINTED_LINES = 10;
const RESIDUE_MAX_SURVIVING_SHARE = 0.2;

// A ten-read probe printed 686 non-blank lines and 676 matched a card; the 10 left were `=== <path>` separators whose bodies the cards had taken.
const SERIALIZED_RESULT_KEYS = new Set(["text", "stdout", "details", "artifact", "images"]);

export function isSerializedNestedResult(text: string, calls: ReadonlyArray<NestedCallRecord> | undefined): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	const nestedTexts = new Set(
		(calls ?? []).flatMap((call) =>
			(nestedCallResult(call)?.content ?? []).flatMap((part) =>
				part.type === "text" && typeof part.text === "string" ? [part.text] : [],
			),
		),
	);
	const values = Array.isArray(parsed) ? parsed : [parsed];
	const directResults =
		values.length > 0 &&
		values.every((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return false;
			const record = value as Record<string, unknown>;
			return (
				typeof record.text === "string" &&
				nestedTexts.has(record.text) &&
				Object.keys(record).every((key) => SERIALIZED_RESULT_KEYS.has(key))
			);
		});
	if (directResults) return true;

	// Reload drops live results. Persisted previews still identify JSON objects made only from nested result texts.
	const previewHeads = (calls ?? []).flatMap((call) => {
		const preview = call.preview;
		if (!preview) return [];
		const withoutCount = preview.replace(/ · \d+ lines$/, "");
		const candidates = [{ head: preview, truncated: false }];
		if (withoutCount !== preview) candidates.push({ head: withoutCount, truncated: false });
		const last = candidates.at(-1)!;
		if (last.head.length === MAX_PREVIEW_CHARS + 1 && last.head.endsWith("…")) {
			last.head = last.head.slice(0, -1);
			last.truncated = true;
		}
		return candidates;
	});
	const pending: unknown[] = [parsed];
	let leaves = 0;
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value === "string") {
			leaves++;
			const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
			if (
				!nestedTexts.has(value) &&
				!previewHeads.some(({ head, truncated }) => (truncated ? firstLine.startsWith(head) : firstLine === head))
			) {
				return false;
			}
			continue;
		}
		const nested = Array.isArray(value)
			? value
			: value && typeof value === "object"
				? Object.values(value as Record<string, unknown>)
				: [];
		if (nested.length === 0) return false;
		for (const item of nested) pending.push(item);
	}
	return leaves > 0;
}

function isSuppressionResidue(printed: number, surviving: number): boolean {
	if (surviving === 0) return true;
	return printed >= RESIDUE_MIN_PRINTED_LINES && surviving <= printed * RESIDUE_MAX_SURVIVING_SHARE;
}

function outputSection(
	text: string,
	theme: CardTheme,
	expanded: boolean,
	failed: boolean,
	echoed: ReadonlySet<string>,
	recordedCopied?: number,
): string[] {
	const rows = text ? text.split(/\r?\n/) : [];
	const { printed, copied } = countEchoed(text, echoed);
	// A replayed row indexes only each call's `preview`, so `copied` collapses to one line per call and a 923-line read
	// printed in full. The count measured at execute time is the floor.
	const echoedCount = Math.max(copied, typeof recordedCopied === "number" ? recordedCopied : 0);
	if (printed === 0 || isSuppressionResidue(printed, printed - echoedCount)) return [];
	const all = rows.filter((line) => !echoed.has(line.trim()));
	if (all.length === 0) return [];
	// Head, not tail: previewing the tail of a structural summary showed the elision marker, a blank line and the footer.
	const visible = all.slice(0, expanded ? EXPANDED_OUTPUT_LINES : COLLAPSED_OUTPUT_LINES);
	const hidden = all.length - visible.length;
	const gutter = `  ${theme.fg("dim", "│ ")}`;
	const lines = visible.map((line) => `${gutter}${theme.fg(failed ? "error" : "toolOutput", line)}`);
	if (hidden > 0) {
		const note = theme.fg("muted", `… +${hidden} lines`);
		lines.push(`${gutter}${note}${expanded ? "" : ` ${keyHint("app.tools.expand", "to expand")}`}`);
	}
	return lines;
}

/** Stripped so the TUI does not draw them twice, and kept on the row's state because later frames see stripped content. */
function emittedImages(
	result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	context: CellRenderContext,
): ReadonlyArray<EmittedImage> {
	const found = result.content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	if (found.length === 0) return context.state?.images ?? [];
	detachToolResultImages(context.toolCallId, result);
	if (context.state) context.state.images = found;
	return found;
}

const IMAGE_MAX_WIDTH_CELLS = 80;
const IMAGE_MAX_HEIGHT_CELLS = 30;

export function renderCellResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: CellRenderDetails;
	},
	{ expanded, isPartial }: { expanded: boolean; isPartial?: boolean },
	theme: CardTheme,
	context: CellRenderContext,
): Component {
	const params: CellRenderDetails = { ...context.args, ...result.details };
	resync(context, params);
	const renderContext = params.sessionId ? { ...context, sessionId: params.sessionId } : context;

	const failed = context.isError === true || params.status === "error";
	const running = isPartial === true || params.status === "running";
	const elapsedMs = runningCellElapsedMs(context.state, running);
	const output = result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.replace(/\n$/, "");

	const cellHeader = cellHeaderParts(params, theme, { ...renderContext, isPartial: running });
	const parts = cellHeader.parts;
	const rows: NestedRow[] = [];
	for (const [index, call] of (params.calls ?? []).entries()) {
		rows.push({
			call,
			components: nestedComponents(call, index, theme, renderContext),
			replay: () => nestedReplayComponents(call, index, theme, renderContext),
			fallback: nestedFallbackLine(call, theme, renderContext),
			status: (drew) => {
				const status = nestedStatusLine(call, theme, expanded, elapsedMs, drew, renderContext);
				return status ? `    ${status}` : undefined;
			},
		});
	}
	if (rows.length > 0) parts.push({ rows, header: (label, grouped) => groupHeaderLine(label, grouped, theme), theme });

	const serializedNestedResult =
		params.serializedNestedResult === true || isSerializedNestedResult(output, params.calls);
	const visibleOutput = params.errorCallId
		? ""
		: serializedNestedResult
			? (params.serializedNestedResultNotice ?? "")
			: output;
	parts.push(
		...outputSection(
			visibleOutput,
			theme,
			expanded,
			failed,
			cachedEchoedLines(params.calls, context.state),
			params.copiedLines,
		),
	);

	for (const image of emittedImages(result, context)) {
		parts.push({
			indent: 2,
			components: [
				new KittyVirtualImage(
					image.data,
					image.mimeType,
					{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
					{ maxWidthCells: IMAGE_MAX_WIDTH_CELLS, maxHeightCells: IMAGE_MAX_HEIGHT_CELLS },
				),
			],
		});
	}

	return framedBlock(theme, {
		header: cellHeader.header,
		sections: parts.length > 0 ? [{ component: new CellStack(parts) }] : [],
		borderColor: failed ? "error" : running ? "borderMuted" : "success",
	});
}
