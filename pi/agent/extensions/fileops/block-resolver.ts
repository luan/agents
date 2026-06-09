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
 * Load failures are cached as `null` so a missing wasm degrades to
 * "unresolvable" instead of crashing the extension.
 */
import { createRequire } from "node:module";
import { Language, type Node, Parser } from "web-tree-sitter";
import type { BlockResolver, BlockSpan } from "./hashline/types.ts";

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

/**
 * Load (and cache) the tree-sitter languages needed to resolve block edits in
 * `paths`. Unknown extensions are skipped; load failures are cached as
 * unresolvable. Safe to call repeatedly.
 */
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

/**
 * Column of the first non-space/tab character on `row` (0-indexed), or `null`
 * when the row is out of range or blank — there is no block to resolve there.
 */
function firstContentColumn(code: string, row: number): number | null {
	const line = code.split("\n")[row];
	if (line === undefined) return null;
	for (let col = 0; col < line.length; col++) {
		const ch = line[col];
		if (ch !== " " && ch !== "\t") return col;
	}
	return null;
}

/**
 * Last content line of `node`, 1-indexed: when a node's final byte is the
 * trailing newline, its `endPosition` lands at column 0 of the NEXT row —
 * counting that row would make every such block one line too long.
 */
function nodeContentEndLine(node: Node): number {
	const pos = node.endPosition;
	const row = pos.column === 0 && pos.row > 0 ? pos.row - 1 : pos.row;
	return row + 1;
}

/**
 * Synchronous tree-sitter block resolver. Returns `null` for unsupported or
 * not-yet-{@link preloadBlockLanguages}'d languages, blank/out-of-range
 * lines, points where no block begins, and error-containing subtrees.
 */
export const treeSitterBlockResolver: BlockResolver = ({ path, text, line }): BlockSpan | null => {
	if (line < 1 || text.length === 0) return null;
	const wasm = wasmForPath(path);
	if (wasm === undefined) return null;
	const language = loadedLanguages.get(wasm);
	if (!language || sharedParser === undefined) return null;

	const row = line - 1;
	const column = firstContentColumn(text, row);
	if (column === null) return null;

	sharedParser.setLanguage(language);
	const tree = sharedParser.parse(text);
	if (!tree) return null;
	try {
		const root = tree.rootNode;
		const leaf = root.namedDescendantForPosition({ row, column });
		if (!leaf) return null;
		// A leaf whose own start row is earlier than `row` means the point
		// landed on a continuation line or a closing delimiter of a block that
		// opened earlier — there is no block *beginning* on line N.
		if (leaf.startPosition.row !== row) return null;
		// Climb to the outermost named ancestor that still begins on `row`,
		// excluding the whole-file root.
		let node = leaf;
		for (let parent = node.parent; parent !== null; parent = node.parent) {
			if (parent.id === root.id) break;
			if (parent.startPosition.row !== row) break;
			node = parent;
		}
		// Refuse degenerate error-recovery spans: a missing brace can make
		// tree-sitter wrap a huge region in an ERROR node. Checking only the
		// resolved node's subtree (not the whole file) keeps an unrelated
		// syntax error elsewhere from disabling the feature.
		if (node.hasError) return null;
		return { start: node.startPosition.row + 1, end: nodeContentEndLine(node) };
	} finally {
		tree.delete();
	}
};
