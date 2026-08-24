import { HUNK_HEADER } from "@pierre/diffs";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import type {
	CreateUnifiedDiffModelOptions,
	UnifiedDiffFile,
	UnifiedDiffFileInput,
	UnifiedDiffHunk,
	UnifiedDiffLine,
	UnifiedDiffModel,
} from "./model.ts";

export const DEFAULT_MAX_CHARACTERS = 1_000_000;
export const DEFAULT_MAX_ROWS = 20_000;
export const DEFAULT_MAX_FILES = 2_000;

export function createStructuredDiffModel(
	files: readonly UnifiedDiffFileInput[],
	revisionOrOptions?: string | CreateUnifiedDiffModelOptions,
): UnifiedDiffModel {
	const options = typeof revisionOrOptions === "string" ? { revision: revisionOrOptions } : (revisionOrOptions ?? {});
	const maxCharacters = positiveInteger(options.maxCharacters, DEFAULT_MAX_CHARACTERS);
	const budget = new StructuredBudget(maxCharacters, positiveInteger(options.maxRows, DEFAULT_MAX_ROWS));
	const converted: UnifiedDiffFile[] = [];
	let additions = 0;
	let removals = 0;
	for (const [index, input] of files.slice(0, DEFAULT_MAX_FILES).entries()) {
		const file = convertFile(input, index, budget);
		if (!file) break;
		converted.push(file);
		additions += file.additions;
		removals += file.removals;
		if (budget.truncated) break;
	}
	const modelFiles = Object.freeze(converted);
	return Object.freeze({
		revision: hash(options.revision ?? JSON.stringify(modelFiles)),
		files: modelFiles,
		preamble: Object.freeze([]),
		additions,
		removals,
		sourceRows: budget.rows,
		truncated:
			budget.truncated ||
			budget.characters >= maxCharacters ||
			Boolean(options.truncated) ||
			files.length > DEFAULT_MAX_FILES,
	});
}

export function hash(value: string): string {
	let result = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16_777_619);
	}
	return (result >>> 0).toString(36);
}

type StructuredRow = UnifiedDiffFileInput["hunks"][number]["rows"][number];

function convertFile(
	input: UnifiedDiffFileInput,
	index: number,
	budget: StructuredBudget,
): UnifiedDiffFile | undefined {
	const fallback = `file-${index}`;
	const bothPathsMissing = input.oldPath === undefined && input.newPath === undefined;
	const oldPath = budget.path(bothPathsMissing ? fallback : input.oldPath);
	const newPath = budget.path(bothPathsMissing ? fallback : input.newPath);
	const headers = input.headerLines ?? [
		`--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`,
		`+++ ${newPath ? `b/${newPath}` : "/dev/null"}`,
	];
	const headerLines: string[] = [];
	for (const header of headers) {
		const bounded = budget.row(sanitizeTuiText(header), 16_384);
		if (bounded === undefined) return undefined;
		headerLines.push(bounded);
		if (budget.truncated) break;
	}

	const hunks: UnifiedDiffHunk[] = [];
	let additions = 0;
	let removals = 0;
	for (const [hunkIndex, inputHunk] of input.hunks.entries()) {
		if (budget.exhausted) {
			budget.truncate();
			break;
		}
		const hunk = convertHunk(inputHunk, `f${index}:h${hunkIndex}`, budget);
		if (!hunk) break;
		hunks.push(hunk);
		for (const line of hunk.lines) {
			if (line.kind === "added") additions += 1;
			if (line.kind === "removed") removals += 1;
		}
		if (budget.truncated) break;
	}
	return Object.freeze({
		ref: `f${index}`,
		oldPath: oldPath || undefined,
		newPath: newPath || undefined,
		headerLines: Object.freeze(headerLines),
		hunks: Object.freeze(hunks),
		additions,
		removals,
	});
}

function convertHunk(
	input: UnifiedDiffFileInput["hunks"][number],
	ref: string,
	budget: StructuredBudget,
): UnifiedDiffHunk | undefined {
	const shape = hunkShape(input);
	const header = budget.row(
		cleanLine(
			input.header ??
				`@@ -${shape.oldStart ?? 0},${input.oldCount ?? shape.oldRows} +${shape.newStart ?? 0},${input.newCount ?? shape.newRows} @@`,
		),
	);
	if (header === undefined) return undefined;

	const lines: UnifiedDiffLine[] = [];
	let oldLine = shape.oldStart;
	let newLine = shape.newStart;
	for (const row of input.rows) {
		const prefix = rowPrefix(row.kind);
		const text = budget.row(`${prefix}${cleanLine(row.text)}`);
		if (text === undefined) break;
		const [old, currentNew, nextOld, nextNew] = lineNumbers(row, oldLine, newLine);
		lines.push(
			Object.freeze({
				ref: `${ref}:l${lines.length}`,
				kind: row.kind,
				text: text.slice(prefix.length),
				oldLine: old,
				newLine: currentNew,
			}),
		);
		oldLine = nextOld;
		newLine = nextNew;
		if (budget.truncated) break;
	}
	return Object.freeze({
		ref,
		header,
		oldStart: shape.oldStart,
		oldCount: shape.oldCount,
		newStart: shape.newStart,
		newCount: shape.newCount,
		lines: Object.freeze(lines),
	});
}

function hunkShape(input: UnifiedDiffFileInput["hunks"][number]): {
	readonly oldStart: number | undefined;
	readonly oldCount: number | undefined;
	readonly newStart: number | undefined;
	readonly newCount: number | undefined;
	readonly oldRows: number;
	readonly newRows: number;
} {
	const header = input.header ? HUNK_HEADER.exec(input.header) : null;
	let oldStart = input.oldStart ?? headerNumber(header?.[1]);
	let newStart = input.newStart ?? headerNumber(header?.[3]);
	let oldRows = 0;
	let newRows = 0;
	for (const row of input.rows) {
		if (row.kind === "context" || row.kind === "removed") {
			oldRows += 1;
			oldStart ??= row.oldLine;
		}
		if (row.kind === "context" || row.kind === "added") {
			newRows += 1;
			newStart ??= row.newLine;
		}
	}
	return {
		oldStart,
		oldCount: input.oldCount ?? headerCount(header?.[2], header),
		newStart,
		newCount: input.newCount ?? headerCount(header?.[4], header),
		oldRows,
		newRows,
	};
}

function headerNumber(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

function headerCount(value: string | undefined, header: RegExpExecArray | null): number | undefined {
	return header === null ? undefined : (headerNumber(value) ?? 1);
}

function rowPrefix(kind: UnifiedDiffLine["kind"]): string {
	return kind === "added" ? "+" : kind === "removed" ? "-" : kind === "context" ? " " : "\\";
}

function lineNumbers(
	row: StructuredRow,
	oldLine: number | undefined,
	newLine: number | undefined,
): readonly [number | undefined, number | undefined, number | undefined, number | undefined] {
	if (row.kind === "metadata" || row.kind === "malformed") return [row.oldLine, row.newLine, oldLine, newLine];
	const old = row.kind === "added" ? row.oldLine : (row.oldLine ?? oldLine);
	const currentNew = row.kind === "removed" ? row.newLine : (row.newLine ?? newLine);
	const nextOld = row.kind === "context" || row.kind === "removed" ? increment(old) : oldLine;
	const nextNew = row.kind === "context" || row.kind === "added" ? increment(currentNew) : newLine;
	return [old, currentNew, nextOld, nextNew];
}

function increment(value: number | undefined): number | undefined {
	return value === undefined ? undefined : value + 1;
}

function cleanLine(text: string): string {
	return sanitizeTuiText(text.replace(/\r?\n$/u, ""));
}

class StructuredBudget {
	characters = 0;
	rows = 0;
	truncated = false;

	constructor(
		private readonly maxCharacters: number,
		private readonly maxRows: number,
	) {}

	get exhausted(): boolean {
		return this.characters >= this.maxCharacters || this.rows >= this.maxRows;
	}

	path(value: string | undefined): string | undefined {
		return value === undefined ? undefined : this.take(sanitizeTuiText(value).slice(0, 4_096), false);
	}

	row(value: string, maxLength = Number.POSITIVE_INFINITY): string | undefined {
		return this.take(value.slice(0, maxLength), true);
	}

	private take(value: string, row: boolean): string | undefined {
		if (row && this.rows >= this.maxRows) return this.truncate();
		const separator = row && this.rows > 0 ? 1 : 0;
		const available = this.maxCharacters - this.characters - separator;
		if (available <= 0) return this.truncate();
		const bounded = value.slice(0, available);
		this.characters += separator + bounded.length;
		if (row) this.rows += 1;
		if (bounded.length < value.length) this.truncated = true;
		return bounded;
	}

	truncate(): undefined {
		this.truncated = true;
		return undefined;
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}
