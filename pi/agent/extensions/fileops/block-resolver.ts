/**
 * Tree-sitter-backed {@link BlockResolver} for `replace block N:` /
 * `delete block N` hashline edits.
 *
 * Resolution algorithm (a port of oh-my-pi's native `blockRangeAt`):
 * find the first content column on the 1-indexed anchor line, take the named
 * descendant at that point, require it to START on that line (a later start
 * row means the point landed on a continuation line or a lone closing
 * delimiter — no block begins there), climb to the outermost named ancestor
 * still starting on that line (excluding the whole-file root), and refuse
 * subtrees containing syntax errors so error-recovery nodes never produce
 * degenerate spans.
 *
 * The hashline {@link BlockResolver} contract is synchronous, but
 * `Language.load` is async — callers must {@link preloadBlockLanguages} for
 * the paths they are about to resolve so the sync resolver hits a warm cache.
 * Load failures are cached as `null` so the resolver and syntax validator
 * return parser-unavailable diagnostics instead of crashing the extension.
 */
import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { BlockResolver, BlockResolverResult, SyntaxValidationResult, SyntaxValidator } from "./hashline/types.ts";

const require = createRequire(import.meta.url);

const WASM_BY_EXTENSION: Record<string, string> = {
	rs: "tree-sitter-rust/tree-sitter-rust.wasm",
	ts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
	mts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
	cts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
	tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
	js: "tree-sitter-javascript/tree-sitter-javascript.wasm",
	mjs: "tree-sitter-javascript/tree-sitter-javascript.wasm",
	cjs: "tree-sitter-javascript/tree-sitter-javascript.wasm",
	jsx: "tree-sitter-javascript/tree-sitter-javascript.wasm",
	py: "tree-sitter-python/tree-sitter-python.wasm",
	pyi: "tree-sitter-python/tree-sitter-python.wasm",
	go: "tree-sitter-go/tree-sitter-go.wasm",
	sh: "tree-sitter-bash/tree-sitter-bash.wasm",
	bash: "tree-sitter-bash/tree-sitter-bash.wasm",
	zsh: "tree-sitter-bash/tree-sitter-bash.wasm",
};

export interface LineSpan {
	startLine: number;
	endLine: number;
}

const resolutionCache = new Map<string, BlockResolverResult>();
const RESOLUTION_CACHE_MAX = 512;

const loadedLanguages = new Map<string, Language | null>();
let runtimeReady: Promise<boolean> | undefined;
let sharedParser: Parser | undefined;

function wasmForPath(path: string): string | undefined {
	const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return WASM_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

function ensureRuntime(): Promise<boolean> {
	runtimeReady ??= Parser.init().then(
		() => true,
		() => false,
	);
	return runtimeReady;
}

export async function preloadBlockLanguages(paths: Iterable<string>): Promise<void> {
	const wanted = new Set<string>();
	for (const path of paths) {
		const wasm = wasmForPath(path);
		if (wasm !== undefined && !loadedLanguages.has(wasm)) wanted.add(wasm);
	}
	if (wanted.size === 0) return;
	if (!(await ensureRuntime())) {
		for (const wasm of wanted) loadedLanguages.set(wasm, null);
		return;
	}
	sharedParser ??= new Parser();
	await Promise.all(
		[...wanted].map(async (wasm) => {
			try {
				loadedLanguages.set(wasm, await Language.load(require.resolve(wasm)));
			} catch {
				loadedLanguages.set(wasm, null);
			}
		}),
	);
}

function firstContentColumn(code: string, row: number): number | null {
	const line = code.split("\n")[row];
	if (line === undefined) return null;
	for (let col = 0; col < line.length; col++) {
		const ch = line[col];
		if (ch !== " " && ch !== "\t") return col;
	}
	return null;
}

function nodeContentEndLine(node: Node): number {
	const pos = node.endPosition;
	const row = pos.column === 0 && pos.row > 0 ? pos.row - 1 : pos.row;
	return row + 1;
}

function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

function cacheKey(path: string, text: string, line: number): string {
	return `${hashText(text)}:${text.length}:${line}:${path}`;
}

function rememberResolution(key: string, value: BlockResolverResult): BlockResolverResult {
	if (resolutionCache.size >= RESOLUTION_CACHE_MAX) {
		const oldest = resolutionCache.keys().next().value;
		if (oldest !== undefined) resolutionCache.delete(oldest);
	}
	resolutionCache.set(key, value);
	return value;
}

function parserForPath(path: string): Parser | null {
	const wasm = wasmForPath(path);
	if (wasm === undefined) return null;
	const language = loadedLanguages.get(wasm);
	if (!language || sharedParser === undefined) return null;
	sharedParser.setLanguage(language);
	return sharedParser;
}

export type StructuralSummaryRow =
	| { kind: "line"; lineNumber: number; text: string }
	| { kind: "ellipsis"; startLine: number; endLine: number };

export interface StructuralSummary {
	rows: StructuralSummaryRow[];
	elidedRanges: LineSpan[];
	elidedLines: number;
}

export function summarizeCodeStructure(path: string, text: string, maxBlockLines = 12): StructuralSummary | undefined {
	const parser = parserForPath(path);
	if (!parser) return undefined;
	const tree = parser.parse(text);
	if (!tree) return undefined;
	try {
		const root = tree.rootNode;
		if (root.hasError) return undefined;
		const lines = text.split("\n");
		const rows: StructuralSummaryRow[] = [];
		const elidedRanges: LineSpan[] = [];
		let cursor = 0;
		const pushLines = (start: number, endExclusive: number) => {
			for (let index = start; index < endExclusive; index++) {
				rows.push({ kind: "line", lineNumber: index + 1, text: lines[index] ?? "" });
			}
		};
		for (let index = 0; index < root.namedChildCount; index++) {
			const child = root.namedChild(index);
			if (!child) continue;
			const start = child.startPosition.row;
			const endExclusive = nodeContentEndLine(child);
			if (start > cursor) pushLines(cursor, start);
			const span = endExclusive - start;
			if (span > maxBlockLines) {
				const headEnd = Math.min(endExclusive - 1, start + 3);
				pushLines(start, headEnd);
				const elidedStart = headEnd + 1;
				const elidedEnd = endExclusive - 1;
				if (elidedStart <= elidedEnd) {
					rows.push({ kind: "ellipsis", startLine: elidedStart, endLine: elidedEnd });
					elidedRanges.push({ startLine: elidedStart, endLine: elidedEnd });
				}
				pushLines(endExclusive - 1, endExclusive);
			} else {
				pushLines(start, endExclusive);
			}
			cursor = Math.max(cursor, endExclusive);
		}
		if (cursor < lines.length) pushLines(cursor, lines.length);
		const elidedLines = elidedRanges.reduce(
			(total, range) => total + Math.max(0, range.endLine - range.startLine + 1),
			0,
		);
		return elidedLines >= 20 ? { rows, elidedRanges, elidedLines } : undefined;
	} finally {
		tree.delete();
	}
}

function countSyntaxErrors(root: Node): number {
	if (!root.hasError) return 0;
	let count = 0;
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (!node.hasError && !node.isError && !node.isMissing) continue;
		if (node.isError || node.isMissing) count++;
		for (let index = 0; index < node.childCount; index++) {
			const child = node.child(index);
			if (child) stack.push(child);
		}
	}
	return count || 1;
}

export const treeSitterSyntaxValidator: SyntaxValidator = ({ path, text }): SyntaxValidationResult => {
	if (wasmForPath(path) === undefined) return { kind: "unsupported_language" };
	const parser = parserForPath(path);
	if (parser === null) return { kind: "parser_unavailable" };
	const tree = parser.parse(text);
	if (!tree) return { kind: "parser_unavailable" };
	try {
		const errorCount = countSyntaxErrors(tree.rootNode);
		return errorCount === 0 ? { kind: "valid", errorCount: 0 } : { kind: "invalid", errorCount };
	} finally {
		tree.delete();
	}
};

export const treeSitterBlockResolver: BlockResolver = ({ path, text, line }): BlockResolverResult => {
	if (line < 1 || text.length === 0) return { reason: "no_block" };
	const key = cacheKey(path, text, line);
	const cached = resolutionCache.get(key);
	if (cached !== undefined) return cached;

	const row = line - 1;
	const column = firstContentColumn(text, row);
	if (column === null) return rememberResolution(key, { reason: "no_block" });
	if (wasmForPath(path) === undefined) return rememberResolution(key, { reason: "unsupported_language" });
	const parser = parserForPath(path);
	if (parser === null) return rememberResolution(key, { reason: "parser_unavailable" });

	const tree = parser.parse(text);
	if (!tree) return rememberResolution(key, { reason: "parser_unavailable" });
	try {
		const root = tree.rootNode;
		if (root.hasError) return rememberResolution(key, { reason: "syntax_error" });
		const leaf = root.namedDescendantForPosition({ row, column });
		if (!leaf) return rememberResolution(key, { reason: "no_block" });
		if (leaf.startPosition.row !== row) return rememberResolution(key, { reason: "no_block" });
		let node = leaf;
		for (let parent = node.parent; parent !== null; parent = node.parent) {
			if (parent.id === root.id) break;
			if (parent.startPosition.row !== row) break;
			node = parent;
		}
		if (node.hasError) return rememberResolution(key, { reason: "syntax_error" });
		return rememberResolution(key, { start: node.startPosition.row + 1, end: nodeContentEndLine(node) });
	} finally {
		tree.delete();
	}
};

function normalizeRanges(ranges: readonly LineSpan[], totalLines: number): LineSpan[] {
	const normalized: LineSpan[] = [];
	for (const range of ranges) {
		const startLine = Math.max(1, Math.trunc(range.startLine));
		const endLine = Math.min(totalLines, Math.trunc(range.endLine));
		if (endLine >= startLine) normalized.push({ startLine, endLine });
	}
	normalized.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: LineSpan[] = [];
	for (const range of normalized) {
		const previous = merged[merged.length - 1];
		if (previous && range.startLine <= previous.endLine + 1)
			previous.endLine = Math.max(previous.endLine, range.endLine);
		else merged.push({ ...range });
	}
	return merged;
}

function lineVisible(ranges: readonly LineSpan[], line: number): boolean {
	return ranges.some((range) => line >= range.startLine && line <= range.endLine);
}

function collectBoundaryLines(node: Node, ranges: readonly LineSpan[], out: Set<number>): void {
	if (node.isNamed && node.parent !== null) {
		const start = node.startPosition.row + 1;
		const end = nodeContentEndLine(node);
		if (end > start) {
			const startVisible = lineVisible(ranges, start);
			const endVisible = lineVisible(ranges, end);
			if (startVisible && !endVisible) out.add(end);
			else if (endVisible && !startVisible) out.add(start);
		}
	}
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child) collectBoundaryLines(child, ranges, out);
	}
}

export function treeSitterEnclosingBlockBoundaries(
	path: string,
	text: string,
	ranges: readonly LineSpan[],
): number[] | null {
	const lines = text.split("\n");
	const normalized = normalizeRanges(ranges, lines.length);
	if (text.length === 0 || normalized.length === 0) return [];
	const parser = parserForPath(path);
	if (parser === null) return null;
	const tree = parser.parse(text);
	if (!tree) return null;
	try {
		const root = tree.rootNode;
		if (root.hasError) return null;
		const out = new Set<number>();
		collectBoundaryLines(root, normalized, out);
		return [...out].sort((left, right) => left - right);
	} finally {
		tree.delete();
	}
}
