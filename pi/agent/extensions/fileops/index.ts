import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";

import { runCommand as runExternalCommand } from "../shared/ct-runner.ts";
import { buildCompactDiffPreview } from "./hashline/diff-preview.ts";
import { formatHashlineHeader, formatNumberedLines } from "./hashline/format.ts";
import { Filesystem, NotFoundError, type WriteResult } from "./hashline/fs.ts";
import { Patch } from "./hashline/input.ts";
import { Patcher } from "./hashline/patcher.ts";
import { stripHashlinePrefixes } from "./hashline/prefixes.ts";
import { InMemorySnapshotStore as UpstreamInMemorySnapshotStore } from "./hashline/snapshots.ts";

type EditMode = "apply_patch" | "patch" | "hashline" | "replace";

type EditConfig = {
	mode: EditMode;
	fuzzyMatch: boolean;
	fuzzyThreshold: number;
	allowReplaceAll: boolean;
};

type ReplaceEntry = {
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type PatchEntry = {
	op: "create" | "delete" | "update";
	diff?: string;
	rename?: string;
};

type EditInput = {
	input?: string;
	path?: string;
	edits?: Array<ReplaceEntry | PatchEntry> | string;
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
	all?: boolean;
};

type NormalizedReplaceEntry = {
	oldText: string;
	newText: string;
	all?: boolean;
};

type NormalizedReplaceInput = {
	path: string;
	edits: NormalizedReplaceEntry[];
};

type ToolTextResult = {
	content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
	details?: Record<string, unknown>;
};

const EDIT_MODES: EditMode[] = ["apply_patch", "patch", "hashline", "replace"];
const DEFAULT_CONFIG: EditConfig = {
	mode: "apply_patch",
	fuzzyMatch: true,
	fuzzyThreshold: 0.95,
	allowReplaceAll: true,
};
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");

const readToolSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the file to read (relative or absolute). Supports file:LINE or file:START-END in hashline mode.",
	}),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	ranges: Type.Optional(Type.Array(Type.String({ description: "Line range such as 10, 10-20, or L10-L20" }))),
	raw: Type.Optional(Type.Boolean({ description: "Return raw file contents without hashline headers" })),
});

const searchToolSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
});

const writeToolSchema = Type.Object({
	path: Type.String({ description: "Path to write" }),
	content: Type.String({ description: "Full file content" }),
	makeExecutable: Type.Optional(Type.Boolean({ description: "Mark written file executable" })),
});

const findToolSchema = Type.Object({
	paths: Type.Optional(Type.Array(Type.String({ description: "Glob including search path" }))),
	pattern: Type.Optional(Type.String({ description: "Legacy glob pattern to match files" })),
	path: Type.Optional(Type.String({ description: "Legacy directory to search in" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files" })),
	gitignore: Type.Optional(Type.Boolean({ description: "Respect gitignore" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

export const HASHLINE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "hashline", "grammar.lark"), "utf-8");
export const APPLY_PATCH_MODE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "apply-patch.lark"), "utf-8");
export const PATCH_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "patch.lark"), "utf-8");
export const REPLACE_GRAMMAR = readFileSync(join(EXTENSION_DIR, "modes", "replace.lark"), "utf-8");

export function getConfiguredEditMode(): EditMode {
	return loadConfig().mode;
}

export function getEditFreeformToolConfig(): { description: string; grammar: string } {
	const config = loadConfig();
	return { description: modeDescription(config), grammar: modeGrammar(config.mode) };
}

const inputSchema = Type.Object({
	input: Type.String({ description: "Full edit payload in the configured edit grammar." }),
});

function normalizeMode(value: unknown): EditMode | undefined {
	return typeof value === "string" && (EDIT_MODES as string[]).includes(value) ? (value as EditMode) : undefined;
}

function loadConfig(): EditConfig {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<EditConfig>;
		const fuzzyThreshold = Number(parsed.fuzzyThreshold);
		return {
			mode:
				normalizeMode(process.env.PI_FILEOPS_EDIT_VARIANT) ??
				normalizeMode(process.env.PI_EDIT_VARIANT) ??
				normalizeMode(parsed.mode) ??
				DEFAULT_CONFIG.mode,
			fuzzyMatch:
				process.env.PI_EDIT_FUZZY === "1" || process.env.PI_EDIT_FUZZY === "true"
					? true
					: process.env.PI_EDIT_FUZZY === "0" || process.env.PI_EDIT_FUZZY === "false"
						? false
						: typeof parsed.fuzzyMatch === "boolean"
							? parsed.fuzzyMatch
							: DEFAULT_CONFIG.fuzzyMatch,
			fuzzyThreshold: Number.isFinite(Number(process.env.PI_EDIT_FUZZY_THRESHOLD))
				? Math.max(0, Math.min(1, Number(process.env.PI_EDIT_FUZZY_THRESHOLD)))
				: Number.isFinite(fuzzyThreshold)
					? Math.max(0, Math.min(1, fuzzyThreshold))
					: DEFAULT_CONFIG.fuzzyThreshold,
			allowReplaceAll:
				typeof parsed.allowReplaceAll === "boolean" ? parsed.allowReplaceAll : DEFAULT_CONFIG.allowReplaceAll,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

async function saveConfig(config: EditConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function modeParameters() {
	return inputSchema;
}

function modeGrammar(mode: EditMode): string {
	switch (mode) {
		case "apply_patch":
			return APPLY_PATCH_MODE_GRAMMAR;
		case "patch":
			return PATCH_GRAMMAR;
		case "hashline":
			return HASHLINE_GRAMMAR;
		case "replace":
			return REPLACE_GRAMMAR;
	}
}

function modeDescription(config: EditConfig): string {
	switch (config.mode) {
		case "apply_patch":
			return "Edit files using the apply_patch envelope format. For Codex this is exposed as a FREEFORM grammar-constrained custom tool.";
		case "patch":
			return "Edit one file using the patch-mode freeform grammar: *** File, then create, update diff hunks, delete, or rename entries.";
		case "hashline":
			return "Edit files using oh-my-pi hashline-style patches: ¶PATH#TAG sections, bare A B/BOF/EOF anchors, +TEXT literal rows, and &A..B repeat rows.";
		case "replace":
			return "Edit one file using the replace-mode freeform grammar: *** File, *** Old, *** New, and optional *** All blocks.";
	}
}

function absolutePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

function textToDisplayLines(text: string): string[] {
	const normalized = normalizeToLf(text);
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

type LineRange = { start: number; end: number };

function parseLineRange(raw: string): LineRange {
	const cleaned = raw
		.trim()
		.replace(/^:/, "")
		.replace(/[Ll](?=\d)/g, "");
	const match = /^([1-9]\d*)(?:\s*(?:-|\.\.)\s*([1-9]\d*))?$/.exec(cleaned);
	if (!match) throw new Error(`Invalid read line selector: ${raw}`);
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (end < start) throw new Error(`Invalid read line selector ${raw}: end is before start.`);
	return { start, end };
}

function splitReadPathSelector(path: string): { path: string; ranges: LineRange[] } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path, ranges: [] };
	const suffix = path.slice(colon + 1);
	if (!/^[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?(?:,\s*[Ll]?\d+(?:\s*(?:-|\.\.)\s*[Ll]?\d+)?)*$/.test(suffix)) {
		return { path, ranges: [] };
	}
	return { path: path.slice(0, colon), ranges: suffix.split(",").map(parseLineRange) };
}

function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: LineRange[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function selectedLineEntries(lines: readonly string[], ranges: readonly LineRange[]): Array<[number, string]> {
	const entries: Array<[number, string]> = [];
	for (const range of ranges) {
		if (range.start > lines.length)
			throw new Error(`Line ${range.start} is beyond end of file (${lines.length} lines total)`);
		const end = Math.min(range.end, lines.length);
		for (let line = range.start; line <= end; line++) entries.push([line, lines[line - 1] ?? ""]);
	}
	return entries;
}

const HASHLINE_SNAPSHOTS = new UpstreamInMemorySnapshotStore();

function recordHashlineContiguous(
	path: string,
	startLine: number,
	lines: readonly string[],
	fullText?: string,
): string {
	return HASHLINE_SNAPSHOTS.recordContiguous(path, startLine, lines, fullText === undefined ? {} : { fullText });
}

function recordHashlineSparse(path: string, entries: Iterable<readonly [number, string]>, fullText?: string): string {
	return HASHLINE_SNAPSHOTS.recordSparse(path, entries, fullText === undefined ? {} : { fullText });
}

function stripHashlineDisplayPrefixes(content: string): { text: string; stripped: boolean } {
	const lines = normalizeToLf(content).split("\n");
	const stripped = stripHashlinePrefixes(lines);
	if (stripped === lines || stripped.join("\n") === lines.join("\n")) return { text: content, stripped: false };
	return { text: stripped.join("\n"), stripped: true };
}

function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const raw = input as Record<string, unknown>;
	const path = typeof raw.path === "string" ? raw.path : typeof raw.file_path === "string" ? raw.file_path : undefined;
	let edits = raw.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {}
	}

	const legacyOld = typeof raw.oldText === "string" ? raw.oldText : raw.old_text;
	const legacyNew = typeof raw.newText === "string" ? raw.newText : raw.new_text;
	if ((typeof legacyOld === "string" || typeof legacyNew === "string") && !Array.isArray(edits)) {
		edits = [{ old_text: legacyOld, new_text: legacyNew, all: raw.all }];
	}

	return { ...raw, path, edits };
}

function normalizeReplaceInput(input: EditInput): NormalizedReplaceInput {
	const prepared = prepareEditArguments(input) as EditInput;
	if (!prepared.path) throw new Error("edit replace mode requires path.");
	if (!Array.isArray(prepared.edits) || prepared.edits.length === 0) {
		throw new Error("edit replace mode requires at least one replacement in edits[].");
	}
	return {
		path: prepared.path,
		edits: (prepared.edits as ReplaceEntry[]).map((edit, index) => {
			const oldText = typeof edit.oldText === "string" ? edit.oldText : edit.old_text;
			const newText = typeof edit.newText === "string" ? edit.newText : edit.new_text;
			if (typeof oldText !== "string") throw new Error(`edit edits[${index}].old_text is required.`);
			if (typeof newText !== "string") throw new Error(`edit edits[${index}].new_text is required.`);
			if (oldText.length === 0) throw new Error(`edit edits[${index}].old_text must not be empty.`);
			return { oldText, newText, all: edit.all };
		}),
	};
}

function toBuiltInInput(input: NormalizedReplaceInput): {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
} {
	return {
		path: input.path,
		edits: input.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
	};
}

function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: text.slice(0, 1), text: text.slice(1) } : { bom: "", text };
}

function detectLineEnding(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function firstChangedLine(before: string, after: string): number | undefined {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const max = Math.max(beforeLines.length, afterLines.length);
	for (let index = 0; index < max; index++) {
		if (beforeLines[index] !== afterLines[index]) return index + 1;
	}
	return undefined;
}

function replaceAllLiteral(text: string, oldText: string, newText: string): { text: string; count: number } {
	const parts = text.split(oldText);
	if (parts.length === 1) return { text, count: 0 };
	return { text: parts.join(newText), count: parts.length - 1 };
}

async function executeReplace(
	cwd: string,
	input: EditInput,
	config: EditConfig,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: EditToolDetails }> {
	const normalized = normalizeReplaceInput(input);
	if (!normalized.edits.some((edit) => edit.all)) {
		return createEditToolDefinition(cwd).execute("edit", toBuiltInInput(normalized), signal);
	}
	if (!config.allowReplaceAll) throw new Error("edit replace mode has all: true disabled by /edit-config.");

	const target = absolutePath(cwd, normalized.path);
	return withFileMutationQueue(target, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const raw = await readFile(target, "utf-8");
		const { bom, text } = stripBom(raw);
		const lineEnding = detectLineEnding(text);
		const before = normalizeToLf(text);
		let current = before;
		let total = 0;

		for (const edit of normalized.edits) {
			const oldText = normalizeToLf(edit.oldText);
			const newText = normalizeToLf(edit.newText);
			if (edit.all) {
				const result = replaceAllLiteral(current, oldText, newText);
				if (result.count === 0) throw new Error(`Could not find old_text in ${normalized.path}.`);
				current = result.text;
				total += result.count;
				continue;
			}

			const first = current.indexOf(oldText);
			if (first === -1) throw new Error(`Could not find old_text in ${normalized.path}.`);
			if (current.indexOf(oldText, first + oldText.length) !== -1) {
				throw new Error(`Found multiple occurrences in ${normalized.path}. Add more context or set all: true.`);
			}
			current = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
			total += 1;
		}

		if (current === before) throw new Error(`Edits to ${normalized.path} resulted in no changes being made.`);
		await writeFile(target, bom + restoreLineEndings(current, lineEnding), "utf-8");

		const patch = createTwoFilesPatch(normalized.path, normalized.path, before, current, "", "", { context: 3 });
		return {
			content: [
				{
					type: "text",
					text: `Successfully replaced ${total} occurrence${total === 1 ? "" : "s"} in ${normalized.path}.`,
				},
			],
			details: { diff: patch, patch, firstChangedLine: firstChangedLine(before, current) },
		};
	});
}

function patchModeToApplyPatch(input: EditInput): string {
	if (!input.path) throw new Error("edit patch mode requires path.");
	if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error("edit patch mode requires edits[].");
	const lines = ["*** Begin Patch"];
	for (const edit of input.edits as PatchEntry[]) {
		if (edit.op === "create") {
			lines.push(`*** Add File: ${input.path}`);
			lines.push(
				...(edit.diff ?? "")
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map((line) => `+${line}`),
			);
			continue;
		}
		if (edit.op === "delete") {
			lines.push(`*** Delete File: ${input.path}`);
			continue;
		}
		if (edit.op === "update") {
			lines.push(`*** Update File: ${input.path}`);
			if (edit.rename) lines.push(`*** Move to: ${edit.rename}`);
			lines.push((edit.diff ?? "").replace(/\r\n?/g, "\n").trimEnd());
			continue;
		}
		throw new Error(`Unsupported edit patch op: ${(edit as { op?: unknown }).op}`);
	}
	lines.push("*** End Patch");
	return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}

function parsePatchInput(input: string): EditInput {
	const edits: PatchEntry[] = [];
	let path: string | undefined;
	let current: PatchEntry | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
	};
	const lines = normalizeToLf(input).split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const line of lines) {
		if (line.trim() === "" && !current) continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Create") {
			flush();
			current = { op: "create", diff: "" };
			continue;
		}
		if (line === "*** Update") {
			flush();
			current = { op: "update", diff: "" };
			continue;
		}
		if (line === "*** Delete") {
			flush();
			current = { op: "delete" };
			continue;
		}
		if (line.startsWith("*** Rename to: ")) {
			if (!current || current.op !== "update") {
				flush();
				current = { op: "update", diff: "" };
			}
			current.rename = line.slice("*** Rename to: ".length).trim();
			continue;
		}
		if (!current || current.op === "delete") throw new Error(`patch mode line outside entry: ${line}`);
		if (current.op === "create") {
			if (!line.startsWith("+")) throw new Error(`create lines must start with '+': ${line}`);
			current.diff = `${current.diff ?? ""}${line.slice(1)}\n`;
		} else {
			current.diff = `${current.diff ?? ""}${line}\n`;
		}
	}
	flush();
	if (!path) throw new Error("patch mode requires a *** File: header.");
	return { path, edits };
}

function parseReplaceInput(input: string): EditInput {
	const edits: ReplaceEntry[] = [];
	let path: string | undefined;
	let current: ReplaceEntry | undefined;
	let bucket: "old" | "new" | undefined;
	const flush = () => {
		if (current) edits.push(current);
		current = undefined;
		bucket = undefined;
	};

	for (const line of normalizeToLf(input).split("\n")) {
		if (line.trim() === "") continue;
		if (line.startsWith("*** File: ")) {
			flush();
			path = line.slice("*** File: ".length).trim();
			continue;
		}
		if (line === "*** Old") {
			flush();
			current = { old_text: "", new_text: "" };
			bucket = "old";
			continue;
		}
		if (line === "*** New") {
			if (!current) throw new Error("replace mode has *** New before *** Old.");
			bucket = "new";
			continue;
		}
		if (line === "*** All") {
			if (!current) throw new Error("replace mode has *** All before replacement.");
			current.all = true;
			continue;
		}
		if (!current || !bucket || !line.startsWith("|")) {
			throw new Error(`replace mode payload line must start with '|': ${line}`);
		}
		const key = bucket === "old" ? "old_text" : "new_text";
		current[key] = `${current[key] ?? ""}${line.slice(1)}\n`;
	}
	flush();
	if (!path) throw new Error("replace mode requires a *** File: header.");
	for (const edit of edits) {
		if (edit.old_text?.endsWith("\n")) edit.old_text = edit.old_text.slice(0, -1);
		if (edit.new_text?.endsWith("\n")) edit.new_text = edit.new_text.slice(0, -1);
	}
	return { path, edits };
}

async function runApplyPatch(cwd: string, input: string, signal?: AbortSignal) {
	const result = await runExternalCommand("ct", ["apply-patch", "--cwd", cwd], cwd, { signal, input });
	return {
		content: [{ type: "text", text: result.stdout || result.stderr || "edit applied" }],
		details: { diff: "", patch: "" },
	};
}

class CwdHashlineFilesystem extends Filesystem {
	constructor(private readonly cwd: string) {
		super();
	}

	#absolute(path: string): string {
		return absolutePath(this.cwd, path);
	}

	async readText(path: string): Promise<string> {
		try {
			return await readFile(this.#absolute(path), "utf-8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new NotFoundError(path, error);
			}
			throw error;
		}
	}

	async preflightWrite(path: string): Promise<void> {
		await mkdir(dirname(this.#absolute(path)), { recursive: true });
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		const absolute = this.#absolute(path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf-8");
		return { text: content };
	}

	canonicalPath(path: string): string {
		return this.#absolute(path);
	}
}

async function withHashlineMutationQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const unique = [...new Set(paths)].sort();
	const run = (index: number): Promise<T> => {
		const path = unique[index];
		if (path === undefined) return fn();
		return withFileMutationQueue(path, () => run(index + 1));
	};
	return run(0);
}

async function executeHashline(cwd: string, input: string) {
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length === 0) throw new Error("hashline mode requires at least one ¶PATH section.");
	const fs = new CwdHashlineFilesystem(cwd);
	const patcher = new Patcher({ fs, snapshots: HASHLINE_SNAPSHOTS });
	const targets = patch.sections.map((section) => fs.canonicalPath(section.path));
	const applied = await withHashlineMutationQueues(targets, () => patcher.apply(patch));
	const diffs = applied.sections.map((section) =>
		createTwoFilesPatch(section.path, section.path, section.before, section.after, "", "", { context: 3 }),
	);
	const diff = diffs.join("\n");
	const noops = applied.sections.filter((section) => section.op === "noop");
	const warnings = applied.sections.flatMap((section) => section.warnings);
	const firstLine = applied.sections.find((section) => section.firstChangedLine !== undefined)?.firstChangedLine;
	const preview = buildCompactDiffPreview(diff).preview;
	return {
		content: [
			{
				type: "text",
				text: [
					`Applied hashline edit to ${applied.sections.length} section${applied.sections.length === 1 ? "" : "s"}.`,
					...applied.sections.map((section) => `${section.op}: ${section.header}`),
					...(noops.length > 0 ? [`No-op sections: ${noops.map((section) => section.path).join(", ")}`] : []),
					...(warnings.length > 0 ? ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)] : []),
				].join("\n"),
			},
		],
		details: {
			diff,
			patch: diff,
			preview,
			results: applied.sections,
			firstChangedLine: firstLine,
		},
	};
}

async function executeByMode(cwd: string, params: EditInput, config: EditConfig, signal?: AbortSignal) {
	switch (config.mode) {
		case "apply_patch":
			if (typeof params.input !== "string") throw new Error("edit apply_patch mode requires input.");
			return runApplyPatch(cwd, params.input, signal);
		case "patch":
			return runApplyPatch(
				cwd,
				patchModeToApplyPatch(
					typeof params.input === "string"
						? parsePatchInput(params.input)
						: (prepareEditArguments(params) as EditInput),
				),
				signal,
			);
		case "hashline":
			if (typeof params.input !== "string") throw new Error("edit hashline mode requires input.");
			return executeHashline(cwd, params.input);
		case "replace":
			return executeReplace(
				cwd,
				typeof params.input === "string" ? parseReplaceInput(params.input) : params,
				config,
				signal,
			);
	}
}

function registerHashlineWorkflowTools(pi: ExtensionAPI, getConfig: () => EditConfig) {
	const cwd = process.cwd();
	const baseRead = createReadToolDefinition(cwd);
	const baseFind = createFindToolDefinition(cwd);
	const baseWrite = createWriteToolDefinition(cwd);

	pi.registerTool({
		...baseRead,
		name: "read",
		description:
			"Read a text file. In hashline edit mode, returns ¶PATH#TAG plus LINE:TEXT rows that can be targeted by hashline edits.",
		parameters: readToolSchema,
		async execute(
			toolCallId,
			params: { path: string; offset?: number; limit?: number; ranges?: string[]; raw?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			if (getConfig().mode !== "hashline") return baseRead.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const selector = splitReadPathSelector(params.path);
			const selectedPath = selector.path;
			const absolute = absolutePath(callCwd, selectedPath);
			const { text: rawText } = stripBom(await readFile(absolute, "utf-8"));
			const text = normalizeToLf(rawText);
			if (params.raw) return { content: [{ type: "text", text }] };
			const allLines = textToDisplayLines(text);
			const explicitRanges = [
				...selector.ranges,
				...(params.ranges ?? []).flatMap((rangeList) => rangeList.split(",").map(parseLineRange)),
			];
			if (explicitRanges.length > 0) {
				const ranges = mergeLineRanges(explicitRanges);
				const entries = selectedLineEntries(allLines, ranges);
				const wholeFile = ranges.length === 1 && ranges[0]?.start === 1 && ranges[0].end >= allLines.length;
				const tag = wholeFile
					? recordHashlineContiguous(absolute, 1, allLines, text)
					: recordHashlineSparse(absolute, entries);
				const output = [
					formatHashlineHeader(displayPath(callCwd, absolute), tag),
					...entries.map(([lineNumber, line]) => `${lineNumber}:${line}`),
				].join("\n");
				return { content: [{ type: "text", text: output }], details: { hashlineTag: tag, ranges } };
			}
			const startLine = Math.max(1, Math.floor(params.offset ?? 1));
			if (startLine > allLines.length)
				throw new Error(`Offset ${startLine} is beyond end of file (${allLines.length} lines total)`);
			const endExclusive =
				params.limit === undefined
					? allLines.length
					: Math.min(allLines.length, startLine - 1 + Math.max(1, params.limit));
			const selected = allLines.slice(startLine - 1, endExclusive);
			const wholeFile = startLine === 1 && endExclusive === allLines.length;
			const tag = recordHashlineContiguous(
				absolute,
				wholeFile ? 1 : startLine,
				wholeFile ? allLines : selected,
				wholeFile ? text : undefined,
			);
			let output = `${formatHashlineHeader(displayPath(callCwd, absolute), tag)}\n${formatNumberedLines(selected.join("\n"), startLine)}`;
			if (endExclusive < allLines.length) {
				output += `\n\n[${allLines.length - endExclusive} more lines in file. Use offset=${endExclusive + 1} or path:${endExclusive + 1}-${allLines.length} to continue.]`;
			}
			return { content: [{ type: "text", text: output }], details: { hashlineTag: tag } };
		},
	});

	pi.registerTool({
		name: "search",
		label: "search",
		description:
			"Search file contents. In hashline edit mode, matching lines are grouped under ¶PATH#TAG headers with LINE:TEXT rows.",
		promptSnippet: "Search file contents and return hashline-editable matches",
		parameters: searchToolSchema,
		async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
			const callCwd = ctx?.cwd ?? cwd;
			const args = ["--line-number", "--color=never", "--hidden", "--no-heading"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.literal) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", String(params.glob));
			if (params.context && params.context > 0) args.push("-C", String(Math.max(0, Math.floor(params.context))));
			if (params.limit && params.limit > 0) args.push("--max-count", String(Math.floor(params.limit)));
			args.push("--", String(params.pattern), params.path ? String(params.path) : ".");
			const result = await runExternalCommand("rg", args, callCwd, { signal, allowNonZero: true });
			if (result.exitCode === 1 || result.stdout.trim().length === 0) {
				return { content: [{ type: "text", text: "No matches found" }] };
			}
			const byFile = new Map<string, Map<number, { text: string; isMatch: boolean }>>();
			for (const line of result.stdout.replace(/\r\n?/g, "\n").split("\n")) {
				if (!line.trim() || line === "--") continue;
				const match = /^(.*?)([:-])([1-9]\d*)([:-])(.*)$/.exec(line);
				const singleFileMatch = !match && params.path ? /^([1-9]\d*)([:-])(.*)$/.exec(line) : undefined;
				if (!match && !singleFileMatch) continue;
				const absolute = match ? absolutePath(callCwd, match[1]) : absolutePath(callCwd, String(params.path));
				const lineNumber = Number(match ? match[3] : singleFileMatch?.[1]);
				const isMatch = (match ? match[2] : singleFileMatch?.[2]) === ":";
				const fileLines = byFile.get(absolute) ?? new Map<number, { text: string; isMatch: boolean }>();
				fileLines.set(lineNumber, { text: match ? match[5] : (singleFileMatch?.[3] ?? ""), isMatch });
				byFile.set(absolute, fileLines);
			}
			const sections: string[] = [];
			for (const [absolute, sparse] of byFile) {
				const ordered = [...sparse.entries()].sort((left, right) => left[0] - right[0]);
				const tag = recordHashlineSparse(
					absolute,
					ordered.map(([lineNumber, entry]) => [lineNumber, entry.text] as const),
				);
				sections.push(
					[
						formatHashlineHeader(displayPath(callCwd, absolute), tag),
						...ordered.map(([lineNumber, entry]) => `${entry.isMatch ? "*" : " "}${lineNumber}:${entry.text}`),
					].join("\n"),
				);
			}
			return { content: [{ type: "text", text: sections.join("\n\n") }] };
		},
	});

	pi.registerTool({
		...baseFind,
		name: "find",
		description: "Find files by glob/path. Accepts either {pattern,path} or oh-my-pi-style {paths:[...]} inputs.",
		parameters: findToolSchema,
		async execute(toolCallId, params: any, signal, onUpdate, ctx) {
			if (!Array.isArray(params.paths)) return baseFind.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 200)));
			const outputs: string[] = [];
			for (const pattern of params.paths) {
				const args = ["--files", "--color=never"];
				if (!params.gitignore) args.push("--no-ignore");
				if (params.hidden) args.push("--hidden");
				args.push("--glob", String(pattern));
				const result = await runExternalCommand("rg", args, callCwd, { signal, allowNonZero: true });
				outputs.push(...result.stdout.split("\n").filter(Boolean));
			}
			const unique = [...new Set(outputs)].slice(0, limit);
			return {
				content: [
					{ type: "text", text: unique.length > 0 ? unique.join("\n") : "No files found matching pattern" },
				],
			};
		},
	});

	pi.registerTool({
		...baseWrite,
		name: "write",
		description:
			"Write a file. In hashline edit mode, copied ¶PATH#TAG and LINE: prefixes are stripped from content before writing.",
		parameters: writeToolSchema,
		async execute(
			toolCallId,
			params: { path: string; content: string; makeExecutable?: boolean },
			signal,
			onUpdate,
			ctx,
		) {
			if (getConfig().mode !== "hashline") return baseWrite.execute(toolCallId, params, signal, onUpdate, ctx);
			const callCwd = ctx?.cwd ?? cwd;
			const stripped = stripHashlineDisplayPrefixes(params.content);
			const absolute = absolutePath(callCwd, params.path);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, stripped.text, "utf-8");
			if (params.makeExecutable || stripped.text.startsWith("#!")) await chmod(absolute, 0o755);
			HASHLINE_SNAPSHOTS.invalidate(absolute);
			const result: ToolTextResult = {
				content: [{ type: "text", text: `Wrote ${params.path}` }],
				details: {},
			};
			if (stripped.stripped) {
				const first = result.content.find(
					(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
				);
				if (first) first.text += "\nNote: auto-stripped hashline display prefixes from content before writing.";
			}
			return result;
		},
	});
}

function formatConfig(config: EditConfig): string {
	return [
		`mode: ${config.mode}`,
		`fuzzyMatch: ${config.fuzzyMatch}`,
		`fuzzyThreshold: ${config.fuzzyThreshold}`,
		`allowReplaceAll: ${config.allowReplaceAll}`,
	].join("\n");
}

export default function fileopsExtension(pi: ExtensionAPI) {
	let config = loadConfig();

	const registerEditTool = () => {
		const current = config;
		pi.registerTool({
			name: "edit",
			label: "edit",
			description: modeDescription(current),
			promptSnippet: "Edit files using the configured edit mode; default mode is apply_patch/freeform.",
			promptGuidelines: [
				"Use edit for file edits when it is active; /edit-config controls whether edit uses apply_patch, patch, hashline, or replace mode.",
				"Each edit mode has its own freeform grammar exposed through the input field.",
				"Use write only when explicitly enabled elsewhere; this configuration keeps write disabled.",
			],
			parameters: modeParameters(),
			renderShell: "self",
			prepareArguments: prepareEditArguments,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeByMode(ctx.cwd, params as EditInput, current, signal);
			},
		});
	};

	registerEditTool();
	registerHashlineWorkflowTools(pi, () => config);

	pi.registerCommand("edit-config", {
		description: "Configure edit mode: apply_patch, patch, hashline, or replace",
		getArgumentCompletions: (prefix: string) => {
			const normalizedPrefix = prefix.trimStart();
			const items = EDIT_MODES.filter((mode) => mode.startsWith(normalizedPrefix)).map((mode) => ({
				value: mode,
				label: mode,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = normalizeMode(args.trim());
			const mode =
				requested ??
				(await ctx.ui.select(
					`Edit mode\n\n${formatConfig(config)}`,
					EDIT_MODES.map((mode) => (mode === config.mode ? `${mode} (current)` : mode)),
				));
			const normalized = normalizeMode(String(mode).replace(/\s+\(current\)$/, ""));
			if (!normalized) {
				ctx.ui.notify(`Usage: /edit-config ${EDIT_MODES.join("|")}`, "error");
				return;
			}
			config = { ...config, mode: normalized };
			await saveConfig(config);
			registerEditTool();
			ctx.ui.notify(`edit mode set to ${config.mode}\n${CONFIG_PATH}`, "info");
		},
	});
}
