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
	// alex-pinkus/tree-sitter-swift ships wasm only as a release asset; this republishes 0.7.3 byte for byte.
	swift: "@binclusive/tree-sitter-swift-wasm/tree-sitter-swift.wasm",
	sh: "tree-sitter-bash/tree-sitter-bash.wasm",
	bash: "tree-sitter-bash/tree-sitter-bash.wasm",
	zsh: "tree-sitter-bash/tree-sitter-bash.wasm",
};

/**
 * Grammars grouped by the node kinds they share.
 *
 * TypeScript, TSX and JavaScript answer to one set: the TS-only kinds
 * (`interface_body`, `object_type`, `enum_body`) simply never appear in a
 * JavaScript tree, so splitting them would cost a table and buy nothing.
 */
type SummaryLanguage = "javascript" | "rust" | "python" | "go" | "bash" | "swift";

const SUMMARY_LANGUAGE_BY_EXTENSION: Record<string, SummaryLanguage> = {
	rs: "rust",
	ts: "javascript",
	mts: "javascript",
	cts: "javascript",
	tsx: "javascript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	py: "python",
	pyi: "python",
	go: "go",
	swift: "swift",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
};

/**
 * Node kinds whose *interior* may be replaced by an ellipsis.
 *
 * These are bodies and large literals, never declarations. Eliding a body
 * leaves its opening line — the signature, the `class X {`, the `[` — and its
 * closing delimiter in place, which is what turns a whole-file read into an
 * outline instead of a hole. Eliding the declaration itself would take the
 * signature with it, which is the one line the reader came for.
 *
 * Parameter lists are here for the same reason a body is: in a codebase that
 * wraps its signatures, one declaration costs six outline rows of which five
 * are one parameter each. Collapsing them keeps the name, the return type and
 * the opening brace — the three parts a reader navigates by.
 */
const ELIDABLE_KINDS: Record<SummaryLanguage, ReadonlySet<string>> = {
	javascript: new Set([
		"statement_block",
		"class_body",
		"interface_body",
		"enum_body",
		"object_type",
		"switch_body",
		"object",
		"array",
		"named_imports",
		"template_string",
		"formal_parameters",
	]),
	rust: new Set([
		"block",
		"declaration_list",
		"field_declaration_list",
		"ordered_field_declaration_list",
		"enum_variant_list",
		"match_block",
		"array_expression",
		"struct_expression",
		"use_list",
		"token_tree",
		"raw_string_literal",
		"parameters",
	]),
	python: new Set(["block", "dictionary", "list", "set", "tuple", "argument_list", "string", "parameters"]),
	go: new Set([
		"block",
		"composite_literal",
		"import_spec_list",
		"field_declaration_list",
		"interface_type",
		"const_declaration",
		"var_declaration",
		"raw_string_literal",
		"parameter_list",
	]),
	swift: new Set([
		"class_body",
		"enum_class_body",
		"protocol_body",
		"function_body",
		"statements",
		"lambda_literal",
		"array_literal",
		"dictionary_literal",
		"multi_line_string_literal",
	]),
	bash: new Set(["compound_statement", "do_group", "case_statement"]),
};

/**
 * Containers whose named children are declarations in their own right.
 *
 * Each such child gets a fold node covering the *whole* member, header
 * included, which is the tier the outline needs above "fold every body": a
 * 4,700-line file has to be able to say "these thirty declarations are here"
 * without spending a row on each one's signature. Deliberately not
 * `statement_block` / `block` — wrapping every statement inside every function
 * would let one function's interior outbid the rest of the file.
 */
const MEMBER_CONTAINER_KINDS: Record<SummaryLanguage, ReadonlySet<string>> = {
	javascript: new Set(["program", "class_body", "interface_body", "enum_body", "object_type"]),
	rust: new Set(["source_file", "declaration_list", "field_declaration_list", "enum_variant_list"]),
	python: new Set(["module"]),
	go: new Set(["source_file", "field_declaration_list", "interface_type"]),
	swift: new Set(["source_file", "class_body", "enum_class_body", "protocol_body"]),
	bash: new Set(["program"]),
};

/**
 * Top-level node kinds worth tallying, keyed by the word the tally prints.
 *
 * The counts ride along on the walk the outline already does. They exist
 * because "how many exported functions does this file have" is a question the
 * outline provokes and, past the point where the budget starts hiding
 * declarations, can no longer answer by being read.
 */
const DECLARATION_LABELS: Record<SummaryLanguage, Record<string, string>> = {
	javascript: {
		function_declaration: "function",
		generator_function_declaration: "function",
		class_declaration: "class",
		abstract_class_declaration: "class",
		interface_declaration: "interface",
		type_alias_declaration: "type",
		enum_declaration: "enum",
		internal_module: "namespace",
		import_statement: "import",
	},
	rust: {
		function_item: "function",
		struct_item: "struct",
		enum_item: "enum",
		trait_item: "trait",
		impl_item: "impl",
		type_item: "type",
		const_item: "const",
		static_item: "static",
		mod_item: "module",
		macro_definition: "macro",
		use_declaration: "import",
	},
	python: {
		function_definition: "function",
		class_definition: "class",
		import_statement: "import",
		import_from_statement: "import",
	},
	go: {
		function_declaration: "function",
		method_declaration: "method",
		type_declaration: "type",
		const_declaration: "const",
		var_declaration: "var",
		import_declaration: "import",
	},
	swift: {
		class_declaration: "class",
		protocol_declaration: "protocol",
		typealias_declaration: "type",
		function_declaration: "function",
		property_declaration: "property",
		import_declaration: "import",
	},
	bash: { function_definition: "function" },
};

/** Languages that mark visibility in the syntax, so an "exported" tally means something. */
const VISIBILITY_MARKED = new Set<SummaryLanguage>(["javascript", "rust", "swift"]);

/** Comment kinds long enough to be worth collapsing to their first prose line. */
const COMMENT_KINDS: Record<SummaryLanguage, ReadonlySet<string>> = {
	javascript: new Set(["comment"]),
	rust: new Set(["block_comment"]),
	python: new Set(["comment"]),
	go: new Set(["comment"]),
	swift: new Set(["comment", "multiline_comment"]),
	bash: new Set(["comment"]),
};

/**
 * Sibling kinds that run in blocks and read as one unit.
 *
 * An import run is the clearest case: thirty `import` lines say "this file
 * depends on things", and the first and last of them say it just as well.
 *
 * Only import-like kinds belong here. A grouped run is folded at every tier,
 * so putting declarations in it — `export_statement` and `mod_item` were both
 * here — hid signatures the unfold pass then had no way to buy back.
 */
const GROUPABLE_KINDS: Record<SummaryLanguage, ReadonlySet<string>> = {
	javascript: new Set(["import_statement"]),
	rust: new Set(["use_declaration"]),
	python: new Set(["import_statement", "import_from_statement"]),
	go: new Set(["import_spec"]),
	swift: new Set(["import_declaration"]),
	bash: new Set([]),
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

function extensionForPath(path: string): string | undefined {
	const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}

function wasmForPath(path: string): string | undefined {
	const extension = extensionForPath(path);
	return extension === undefined ? undefined : WASM_BY_EXTENSION[extension];
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

/** What the file declares at top level, tallied while the outline is built. */
export interface DeclarationCounts {
	/** Kinds and their totals, most numerous first. */
	byKind: Array<{ label: string; count: number }>;
	/** How many carry an export/visibility marker, or undefined if the language has none. */
	exported?: number;
}

export interface StructuralSummary {
	rows: StructuralSummaryRow[];
	elidedRanges: LineSpan[];
	elidedLines: number;
	/** Lines the file has, so a caller can report how much the outline saved. */
	totalLines: number;
	counts: DeclarationCounts;
}

export interface StructuralSummaryOptions {
	/** Bodies shorter than this stay verbatim; collapsing them saves nothing. */
	minBodyLines?: number;
	/** Comments shorter than this stay verbatim. */
	minCommentLines?: number;
	/** Hard ceiling on the rendered outline, in estimated tokens. */
	maxTokens?: number;
}

const DEFAULT_MIN_BODY_LINES = 4;
const DEFAULT_MIN_COMMENT_LINES = 6;

/**
 * The outline's size ceiling, in the same estimated tokens the tool budget uses.
 *
 * Bounding in lines was the mistake this replaces: a 200-line file and a
 * 4,700-line file both fitted "100 visible lines", but the second one's hundred
 * lines were signatures and the outline landed at ~7,700 tokens — past the
 * 6,000-token read budget, so the bound that was supposed to make the outline
 * affordable got it middle-truncated instead.
 *
 * The cap is what a huge file gets. The share is what everything else gets:
 * an outline worth more than a third of the file it summarizes is not an
 * outline, and the floor keeps that share from starving a file just over the
 * summarization threshold.
 */
const OUTLINE_TOKEN_CAP = 3_500;
const OUTLINE_TOKEN_FLOOR = 400;
const OUTLINE_FILE_SHARE = 1 / 3;

/** Divisor behind the shared `approxTokenCount`; the budget is measured in bytes. */
const BYTES_PER_TOKEN = 4;

/** `…` plus its newline — what one elided span costs the outline. */
const ELLIPSIS_ROW_BYTES = 4;

function spanLines(span: LineSpan): number {
	return Math.max(0, span.endLine - span.startLine + 1);
}

/**
 * One elidable region and the elidable regions nested directly inside it.
 *
 * The forest exists because "elide the body" is the wrong answer at exactly one
 * scale. A class body elided whole hides every method signature; a class body
 * kept whole hides nothing at all. Recording every level lets the unfold pass
 * below pick the scale that fits the budget instead of committing up front.
 *
 * Unfolding a node means dropping its span and folding its children instead, so
 * the lines it reveals are its own minus theirs. A node with no children still
 * unfolds — it just reveals everything it was hiding.
 */
interface SpanNode {
	span: LineSpan;
	children: number[];
	/** Distance from a root, which is the tier the unfold pass advances through. */
	depth: number;
	/** Set when unfolding this node reveals declaration headers rather than statements. */
	structural: boolean;
	/** Tie-break for a tier the budget cannot afford whole; higher goes first. */
	weight: number;
}

interface ElidableForest {
	nodes: SpanNode[];
	roots: number[];
}

function pushSpan(
	forest: ElidableForest,
	parent: number | undefined,
	span: LineSpan,
	traits: { structural?: boolean; weight?: number } = {},
): number {
	const index = forest.nodes.length;
	forest.nodes.push({
		span,
		children: [],
		depth: parent === undefined ? 0 : forest.nodes[parent]!.depth + 1,
		structural: traits.structural ?? false,
		weight: traits.weight ?? 1,
	});
	if (parent === undefined) forest.roots.push(index);
	else forest.nodes[parent]!.children.push(index);
	return index;
}

/** Lines from the node's first row through its last row carrying content. */
function nodeLineCount(node: Node): number {
	return Math.max(1, nodeContentEndLine(node) - node.startPosition.row);
}

/**
 * The interior of `node`: everything after its opening line and before its
 * last content line.
 *
 * Both boundary lines survive on purpose. For a brace language they are the
 * signature and the closing brace; for Python they are the first and last
 * statement of the suite, which read as a summary of it.
 */
function interiorSpan(node: Node): LineSpan | undefined {
	const startLine = node.startPosition.row + 2;
	const endLine = nodeContentEndLine(node) - 1;
	return startLine <= endLine ? { startLine, endLine } : undefined;
}

/** A line holding nothing but the delimiters that close what came before it. */
function isCloserLine(text: string | undefined): boolean {
	return text !== undefined && text.trim().length > 0 && /^[\s)\]}>,;]*$/.test(text);
}

/**
 * The interior of `node` plus the line that closes it, when that line is only
 * delimiters.
 *
 * On a 4,700-line file the closing braces alone were two hundred outline rows
 * saying `}`. Python's last suite line is a statement and must survive, so the
 * test is textual rather than per-grammar: whatever the grammar, a line of pure
 * punctuation adds nothing the signature above the ellipsis has not said.
 */
function bodySpan(node: Node, lines: readonly string[]): LineSpan | undefined {
	const span = interiorSpan(node);
	if (!span) return undefined;
	const closer = span.endLine + 1;
	return isCloserLine(lines[closer - 1]) ? { startLine: span.startLine, endLine: closer } : span;
}

/**
 * Everything in a comment past its first prose line.
 *
 * A doc comment's first sentence is the part that belongs next to the
 * signature; its closing delimiter is not, so unlike a body the last line goes
 * with the interior.
 */
function commentSpan(node: Node): LineSpan | undefined {
	const startLine = node.startPosition.row + 3;
	const endLine = nodeContentEndLine(node);
	return startLine <= endLine ? { startLine, endLine } : undefined;
}

function flushGroupableRun(
	forest: ElidableForest,
	parent: number | undefined,
	first: Node | undefined,
	last: Node | undefined,
	count: number,
	minBodyLines: number,
): void {
	if (count < 2 || !first || !last) return;
	const firstStart = first.startPosition.row + 1;
	const lastStart = last.startPosition.row + 1;
	if (nodeContentEndLine(last) - firstStart + 1 < minBodyLines) return;
	const startLine = Math.min(nodeContentEndLine(first), lastStart - 1) + 1;
	const endLine = lastStart - 1;
	if (startLine <= endLine) pushSpan(forest, parent, { startLine, endLine });
}

/** Unfolding this reveals whole declaration headers, so it outbids a body. */
const WEIGHT_MEMBER_CONTAINER = 3;
/** An exported declaration is the one a reader of an unfamiliar file came for. */
const WEIGHT_EXPORTED_MEMBER = 2;
const WEIGHT_DEFAULT = 1;

interface WalkContext {
	language: SummaryLanguage;
	minBodyLines: number;
	minCommentLines: number;
	lines: readonly string[];
	/** Top-level tally, filled as the file's own members are wrapped. */
	counts: Map<string, number>;
	exported: number;
}

function isMemberContainer(node: Node, language: SummaryLanguage): boolean {
	if (MEMBER_CONTAINER_KINDS[language].has(node.type)) return true;
	// Python has no distinct class-body kind: the suite under a class is the
	// same block node a function gets, so the parent is what tells them apart.
	return language === "python" && node.type === "block" && node.parent?.type === "class_definition";
}

/** The five kinds `class_declaration` collapses; 6,013 nodes over ~/src/arc, 3,417 of them `extension`. */
const SWIFT_TYPE_KEYWORDS = new Set(["class", "struct", "enum", "extension", "actor"]);

/** Visibility keywords that reach outside the declaring module; Swift's unmarked default does not. */
const SWIFT_EXPORTED_VISIBILITY = new Set(["public", "open", "package"]);

function swiftTypeKeyword(node: Node): string | undefined {
	for (let index = 0; index < node.childCount; index++) {
		const type = node.child(index)?.type;
		if (type !== undefined && SWIFT_TYPE_KEYWORDS.has(type)) return type;
	}
	return undefined;
}

/** Swift keeps visibility in a `modifiers` child, and `public private(set)` carries two of them. */
function swiftIsExported(node: Node): boolean {
	for (let index = 0; index < node.namedChildCount; index++) {
		const modifiers = node.namedChild(index);
		if (modifiers?.type !== "modifiers") continue;
		for (let child = 0; child < modifiers.namedChildCount; child++) {
			const modifier = modifiers.namedChild(child);
			if (modifier?.type !== "visibility_modifier") continue;
			if (SWIFT_EXPORTED_VISIBILITY.has(modifier.text.split("(")[0]!.trim())) return true;
		}
	}
	return false;
}

function declarationLabel(node: Node, language: SummaryLanguage): string | undefined {
	if (language === "javascript" && node.type === "export_statement") {
		const declaration = node.childForFieldName("declaration");
		return declaration ? declarationLabel(declaration, language) : undefined;
	}
	if (language === "python" && node.type === "decorated_definition") {
		const definition = node.childForFieldName("definition");
		return definition ? declarationLabel(definition, language) : undefined;
	}
	if (language === "swift" && node.type === "class_declaration") return swiftTypeKeyword(node) ?? "class";
	const label = DECLARATION_LABELS[language][node.type];
	if (label) return label;
	if (language !== "javascript") return undefined;
	if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return undefined;
	// A const bound to an arrow function is a function to everyone but the grammar.
	const value = node.namedChild(0)?.childForFieldName("value");
	return value?.type === "arrow_function" || value?.type === "function_expression" ? "function" : "const";
}

function isExportedMember(node: Node, language: SummaryLanguage): boolean {
	if (language === "javascript") return node.type === "export_statement";
	if (language === "swift") return swiftIsExported(node);
	if (language !== "rust") return false;
	for (let index = 0; index < node.childCount; index++) {
		if (node.child(index)?.type === "visibility_modifier") return true;
	}
	return false;
}

function collectElidableSpans(
	node: Node,
	parent: number | undefined,
	context: WalkContext,
	forest: ElidableForest,
): void {
	const { language } = context;
	if (COMMENT_KINDS[language].has(node.type)) {
		if (nodeLineCount(node) >= context.minCommentLines) {
			const span = commentSpan(node);
			if (span) pushSpan(forest, parent, span);
		}
		return;
	}

	let current = parent;
	if (ELIDABLE_KINDS[language].has(node.type) && nodeLineCount(node) >= context.minBodyLines) {
		const span = bodySpan(node, context.lines);
		// Recurse *into* the elided node so its own bodies become children. The
		// unfold pass decides which level actually fires.
		if (span) current = pushSpan(forest, parent, span);
	}

	const groupable = GROUPABLE_KINDS[language];
	let runFirst: Node | undefined;
	let runLast: Node | undefined;
	let runCount = 0;
	for (let index = 0; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (!child) continue;
		if (groupable.has(child.type)) {
			runFirst ??= child;
			runLast = child;
			runCount += 1;
			continue;
		}
		flushGroupableRun(forest, current, runFirst, runLast, runCount, context.minBodyLines);
		runFirst = undefined;
		runLast = undefined;
		runCount = 0;
	}
	flushGroupableRun(forest, current, runFirst, runLast, runCount, context.minBodyLines);

	// A member container's children each get a fold node of their own, covering
	// the member whole. Members already folded into a groupable run are skipped
	// so the two mechanisms never claim the same lines — the unfold pass assumes
	// siblings are disjoint when it prices what a node reveals.
	const wrapMembers = isMemberContainer(node, language);
	const tally = node.parent === null;
	for (let index = 0; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (!child) continue;
		const exported = isExportedMember(child, language);
		if (tally) {
			const label = declarationLabel(child, language);
			if (label) {
				context.counts.set(label, (context.counts.get(label) ?? 0) + 1);
				if (exported) context.exported += 1;
			}
		}
		let memberParent = current;
		if (wrapMembers && !groupable.has(child.type)) {
			memberParent = pushSpan(
				forest,
				current,
				{ startLine: child.startPosition.row + 1, endLine: nodeContentEndLine(child) },
				{ structural: true, weight: exported ? WEIGHT_EXPORTED_MEMBER : WEIGHT_DEFAULT },
			);
			if (current !== undefined) {
				const container = forest.nodes[current]!;
				container.structural = true;
				container.weight = WEIGHT_MEMBER_CONTAINER;
			}
		}
		collectElidableSpans(child, memberParent, context, forest);
	}
}

/**
 * What each outline row costs, so the unfold pass can price a tier.
 *
 * Lines are priced as `N:TEXT\n`, which is what the numbered read emits and an
 * upper bound on what the unnumbered one does.
 */
interface OutlineCostModel {
	/** Rendered bytes of lines 1..i, so a span's cost is one subtraction. */
	prefix: number[];
	blank: boolean[];
	totalBytes: number;
	totalLines: number;
}

function buildCostModel(lines: readonly string[]): OutlineCostModel {
	const prefix = new Array<number>(lines.length + 1).fill(0);
	const blank = new Array<boolean>(lines.length + 1).fill(false);
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index] ?? "";
		prefix[index + 1] = prefix[index]! + Buffer.byteLength(text, "utf8") + String(index + 1).length + 2;
		blank[index + 1] = text.trim().length === 0;
	}
	return { prefix, blank, totalBytes: prefix[lines.length]!, totalLines: lines.length };
}

function spanBytes(span: LineSpan, cost: OutlineCostModel): number {
	return cost.prefix[span.endLine]! - cost.prefix[span.startLine - 1]!;
}

/**
 * Grow each span over the blank lines touching it, then merge and sort.
 *
 * A blank line next to an ellipsis is a row that says nothing and, worse, keeps
 * two elided spans from merging into one — which costs a second ellipsis and a
 * second entry in the footer's recovery list.
 */
function materializeRanges(spans: readonly LineSpan[], cost: OutlineCostModel): LineSpan[] {
	const grown: LineSpan[] = [];
	for (const span of spans) {
		let { startLine, endLine } = span;
		while (startLine > 1 && cost.blank[startLine - 1]) startLine -= 1;
		while (endLine < cost.totalLines && cost.blank[endLine + 1]) endLine += 1;
		grown.push({ startLine, endLine });
	}
	return normalizeRanges(grown, cost.totalLines);
}

function outlineBytes(ranges: readonly LineSpan[], cost: OutlineCostModel): number {
	let hidden = 0;
	for (const range of ranges) hidden += spanBytes(range, cost);
	return cost.totalBytes - hidden + ranges.length * ELLIPSIS_ROW_BYTES;
}

function foldedSpans(forest: ElidableForest, folded: Iterable<number>): LineSpan[] {
	return [...folded].map((index) => forest.nodes[index]!.span);
}

function unfold(forest: ElidableForest, folded: Set<number>, indices: Iterable<number>): Set<number> {
	const next = new Set(folded);
	for (const index of indices) {
		next.delete(index);
		for (const child of forest.nodes[index]!.children) next.add(child);
	}
	return next;
}

/**
 * Choose which spans stay folded, one tier at a time, against a token budget.
 *
 * Every root starts folded, which is the cheapest possible outline: on a large
 * file that is the whole file behind a handful of ellipses. Each pass unfolds
 * an entire tier — every top-level member, then every one of their bodies and
 * parameter lists, then every class member, and so on — and keeps it only if
 * the whole tier fits. Advancing tier by tier rather than node by node is what
 * makes the outline scale: a breadth-first walk that stops when the budget runs
 * out spends it all on the top of the file and leaves the bottom invisible.
 *
 * The first tier that does not fit whole is bought piecewise, but only where
 * unfolding reveals declarations: exported ones first, then whichever name the
 * most per byte. Buying part of a tier of function *bodies* would just show a
 * few random implementations, so those tiers are refused outright and the
 * outline stops one level above.
 */
function selectFoldedSpans(forest: ElidableForest, cost: OutlineCostModel, budgetBytes: number): LineSpan[] {
	let folded = new Set(forest.roots);
	if (folded.size === 0) return [];
	let selected = materializeRanges(foldedSpans(forest, folded), cost);
	let bytes = outlineBytes(selected, cost);

	for (let tier = 0; folded.size > 0; tier++) {
		const nodes = [...folded].filter((index) => forest.nodes[index]!.depth === tier);
		if (nodes.length === 0) break;

		const whole = unfold(forest, folded, nodes);
		const wholeRanges = materializeRanges(foldedSpans(forest, whole), cost);
		const wholeBytes = outlineBytes(wholeRanges, cost);
		if (wholeBytes <= budgetBytes) {
			folded = whole;
			selected = wholeRanges;
			bytes = wholeBytes;
			continue;
		}

		// Pricing one unfold in isolation misses what the later
		// `materializeRanges` does to its neighbours: two spans that merged over a
		// blank line stop merging once one of them opens. The estimate is
		// therefore close but not sound, so the buys are re-priced exactly below.
		const revealed = new Map<number, number>();
		for (const index of nodes) {
			const node = forest.nodes[index]!;
			let revealedBytes = spanBytes(node.span, cost);
			for (const child of node.children) revealedBytes -= spanBytes(forest.nodes[child]!.span, cost);
			revealed.set(index, Math.max(0, revealedBytes) + Math.max(0, node.children.length - 1) * ELLIPSIS_ROW_BYTES);
		}
		const affordable = nodes
			.filter((index) => forest.nodes[index]!.structural)
			.sort((left, right) => {
				const byWeight = forest.nodes[right]!.weight - forest.nodes[left]!.weight;
				if (byWeight !== 0) return byWeight;
				const byCost = revealed.get(left)! - revealed.get(right)!;
				return byCost !== 0 ? byCost : forest.nodes[left]!.span.startLine - forest.nodes[right]!.span.startLine;
			});
		const bought: number[] = [];
		for (const index of affordable) {
			const next = bytes + revealed.get(index)!;
			if (next > budgetBytes) continue;
			bytes = next;
			bought.push(index);
		}
		// Give back the least significant buys until the exact price fits. The
		// estimate above is high by construction on all but the merge case, so
		// this settles in a handful of steps and never below the tier's own cost.
		while (bought.length > 0) {
			const candidate = materializeRanges(foldedSpans(forest, unfold(forest, folded, bought)), cost);
			if (outlineBytes(candidate, cost) <= budgetBytes) {
				selected = candidate;
				break;
			}
			bought.pop();
		}
		break;
	}
	return selected;
}

/**
 * Outline the text as declarations plus elided bodies, or undefined when the
 * file is not parseable or has nothing worth eliding.
 */
export function summarizeCodeStructure(
	path: string,
	text: string,
	options: StructuralSummaryOptions = {},
): StructuralSummary | undefined {
	const extension = extensionForPath(path);
	const language = extension === undefined ? undefined : SUMMARY_LANGUAGE_BY_EXTENSION[extension];
	if (!language) return undefined;
	const parser = parserForPath(path);
	if (!parser) return undefined;
	const tree = parser.parse(text);
	if (!tree) return undefined;
	try {
		const root = tree.rootNode;
		if (root.hasError) return undefined;
		const rawLines = text.split("\n");
		// A trailing newline yields a phantom final element. Drop it so line
		// numbers here match the rest of the read path.
		const lines = rawLines.length > 1 && rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines;
		const totalLines = lines.length;

		const context: WalkContext = {
			language,
			minBodyLines: Math.max(2, options.minBodyLines ?? DEFAULT_MIN_BODY_LINES),
			minCommentLines: Math.max(4, options.minCommentLines ?? DEFAULT_MIN_COMMENT_LINES),
			lines,
			counts: new Map(),
			exported: 0,
		};
		const forest: ElidableForest = { nodes: [], roots: [] };
		collectElidableSpans(root, undefined, context, forest);

		const cost = buildCostModel(lines);
		const cap = (options.maxTokens ?? OUTLINE_TOKEN_CAP) * BYTES_PER_TOKEN;
		const budgetBytes = Math.min(
			cap,
			Math.max(OUTLINE_TOKEN_FLOOR * BYTES_PER_TOKEN, cost.totalBytes * OUTLINE_FILE_SHARE),
		);
		const elidedRanges = selectFoldedSpans(forest, cost, budgetBytes);
		if (elidedRanges.length === 0) return undefined;

		const rows: StructuralSummaryRow[] = [];
		let spanIndex = 0;
		for (let line = 1; line <= totalLines; ) {
			const span = elidedRanges[spanIndex];
			if (span && line >= span.startLine) {
				rows.push({ kind: "ellipsis", startLine: span.startLine, endLine: span.endLine });
				line = span.endLine + 1;
				spanIndex += 1;
				continue;
			}
			rows.push({ kind: "line", lineNumber: line, text: lines[line - 1] ?? "" });
			line += 1;
		}
		const elidedLines = elidedRanges.reduce((total, range) => total + spanLines(range), 0);
		const byKind = [...context.counts]
			.map(([label, count]) => ({ label, count }))
			.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
		const counts: DeclarationCounts = {
			byKind,
			exported: VISIBILITY_MARKED.has(language) ? context.exported : undefined,
		};
		return { rows, elidedRanges, elidedLines, totalLines, counts };
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
		// One column wide, not zero: Swift's hidden implicit-semi token spans the newline and eats a point lookup.
		const leaf = root.namedDescendantForPosition({ row, column }, { row, column: column + 1 });
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
