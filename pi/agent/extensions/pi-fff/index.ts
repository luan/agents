/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and can also replace
 * @-mention autocomplete suggestions in the interactive editor.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FileFinder, GrepCursor, GrepMode, GrepResult, MixedItem, SearchResult } from "@ff-labs/fff-node";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor, DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	type ExplorationAction,
	isExplorationHidden,
	registerExplorationEventHandlers,
	registerExplorationTool,
	renderExplorationCall,
} from "../shared/exploration-rendering";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 200;
const GREP_MAX_LINE_LENGTH = 500;
const MENTION_MAX_RESULTS = 20;
const RUNTIME_CACHE_VERSION = "v1";

type FffNodeModule = typeof import("@ff-labs/fff-node");

type FffMode = "tools-and-ui" | "tools-only" | "override";

const VALID_MODES: FffMode[] = ["tools-and-ui", "tools-only", "override"];

interface ToolNames {
	grep: string;
	find: string;
	multiGrep: string;
}

const FFF_TOOL_NAMES: ToolNames = {
	grep: "ffgrep",
	find: "fffind",
	multiGrep: "fff-multi-grep",
};
const OVERRIDE_TOOL_NAMES: ToolNames = {
	grep: "grep",
	find: "find",
	multiGrep: "multi_grep",
};

function resolveToolNames(mode: FffMode): ToolNames {
	return mode === "override" ? OVERRIDE_TOOL_NAMES : FFF_TOOL_NAMES;
}

// ---------------------------------------------------------------------------
// Safe native runtime loading
// ---------------------------------------------------------------------------

interface PackageJson {
	name?: string;
	version?: string;
	optionalDependencies?: Record<string, string>;
}

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
let fffNodeModulePromise: Promise<FffNodeModule> | null = null;

function packageSegments(packageName: string): string[] {
	return packageName.split("/");
}

function packageDir(nodeModulesDir: string, packageName: string): string {
	return path.join(nodeModulesDir, ...packageSegments(packageName));
}

function readPackageJson(packageRoot: string): PackageJson {
	return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function findSourceNodeModules(): string {
	let dir = extensionDir;
	while (true) {
		const candidate = path.join(dir, "node_modules", "@ff-labs", "fff-node", "package.json");
		if (existsSync(candidate)) return path.join(dir, "node_modules");

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not find @ff-labs/fff-node in extension node_modules");
}

function runtimeCacheBase(): string {
	return (
		process.env.PI_FFF_RUNTIME_DIR ??
		path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "pi-fff", "runtime")
	);
}

function runtimeKey(fffPackage: PackageJson, ffiPackage: PackageJson): string {
	return [
		`${fffPackage.name ?? "fff-node"}@${fffPackage.version ?? "unknown"}`,
		`${ffiPackage.name ?? "ffi-rs"}@${ffiPackage.version ?? "unknown"}`,
		`${process.platform}-${process.arch}`,
		RUNTIME_CACHE_VERSION,
	]
		.join("_")
		.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function copyPackage(sourceNodeModules: string, targetNodeModules: string, packageName: string): void {
	const source = packageDir(sourceNodeModules, packageName);
	if (!existsSync(path.join(source, "package.json"))) return;

	const target = packageDir(targetNodeModules, packageName);
	mkdirSync(path.dirname(target), { recursive: true });
	cpSync(source, target, {
		recursive: true,
		dereference: false,
		errorOnExist: false,
		force: false,
	});
}

function copyInstalledOptionalDependencies(
	sourceNodeModules: string,
	targetNodeModules: string,
	packageJson: PackageJson,
): void {
	for (const packageName of Object.keys(packageJson.optionalDependencies ?? {})) {
		copyPackage(sourceNodeModules, targetNodeModules, packageName);
	}
}

function ensureSafeFffRuntime(): string {
	const sourceNodeModules = findSourceNodeModules();
	const fffPackage = readPackageJson(packageDir(sourceNodeModules, "@ff-labs/fff-node"));
	const ffiPackage = readPackageJson(packageDir(sourceNodeModules, "ffi-rs"));
	const runtimeRoot = path.join(runtimeCacheBase(), runtimeKey(fffPackage, ffiPackage));
	const markerPath = path.join(runtimeRoot, ".ready.json");

	if (existsSync(markerPath)) return runtimeRoot;

	const tmpRoot = `${runtimeRoot}.tmp-${process.pid}-${Date.now()}`;
	rmSync(tmpRoot, { recursive: true, force: true });
	mkdirSync(path.join(tmpRoot, "node_modules"), { recursive: true });

	try {
		const targetNodeModules = path.join(tmpRoot, "node_modules");
		copyPackage(sourceNodeModules, targetNodeModules, "@ff-labs/fff-node");
		copyPackage(sourceNodeModules, targetNodeModules, "ffi-rs");
		copyInstalledOptionalDependencies(sourceNodeModules, targetNodeModules, fffPackage);
		copyInstalledOptionalDependencies(sourceNodeModules, targetNodeModules, ffiPackage);

		const entry = path.join(targetNodeModules, "@ff-labs", "fff-node", "dist", "src", "index.js");
		if (!existsSync(entry)) throw new Error(`Missing staged @ff-labs/fff-node entrypoint: ${entry}`);

		mkdirSync(path.dirname(runtimeRoot), { recursive: true });
		writeFileSync(
			path.join(tmpRoot, ".ready.json"),
			JSON.stringify(
				{
					fffNode: fffPackage.version,
					ffiRs: ffiPackage.version,
					platform: process.platform,
					arch: process.arch,
					cacheVersion: RUNTIME_CACHE_VERSION,
				},
				null,
				2,
			),
		);
		rmSync(runtimeRoot, { recursive: true, force: true });
		renameSync(tmpRoot, runtimeRoot);
		return runtimeRoot;
	} catch (error) {
		rmSync(tmpRoot, { recursive: true, force: true });
		throw error;
	}
}

async function loadFffNodeModule(): Promise<FffNodeModule> {
	if (!fffNodeModulePromise) {
		const runtimeRoot = ensureSafeFffRuntime();
		const entry = path.join(runtimeRoot, "node_modules", "@ff-labs", "fff-node", "dist", "src", "index.js");
		fffNodeModulePromise = import(pathToFileURL(entry).href) as Promise<FffNodeModule>;
	}
	return fffNodeModulePromise;
}

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

const cursorCache = new Map<string, GrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor): string {
	const id = `fff_c${++cursorCounter}`;
	cursorCache.set(id, cursor);
	if (cursorCache.size > 200) {
		const first = cursorCache.keys().next().value;
		if (first) cursorCache.delete(first);
	}
	return id;
}

function getCursor(id: string): GrepCursor | undefined {
	return cursorCache.get(id);
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function formatGrepOutput(result: GrepResult, limit: number): string {
	const items = result.items.slice(0, limit);
	if (items.length === 0) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of items) {
		if (match.relativePath !== currentFile) {
			currentFile = match.relativePath;
			if (lines.length > 0) lines.push("");
		}

		match.contextBefore?.forEach((line: string, i: number) => {
			lines.push(
				`${match.relativePath}-${match.lineNumber - match.contextBefore!.length + i}- ${truncateLine(line)}`,
			);
		});

		lines.push(`${match.relativePath}:${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		match.contextAfter?.forEach((line: string, i: number) => {
			lines.push(`${match.relativePath}-${match.lineNumber + 1 + i}- ${truncateLine(line)}`);
		});
	}

	return lines.join("\n");
}

function formatFindOutput(result: SearchResult, limit: number): string {
	const items = result.items.slice(0, limit);
	return items.length === 0
		? "No files found matching pattern"
		: items.map((i: { relativePath: string }) => i.relativePath).join("\n");
}

function getResultText(result: { content?: { type: string; text?: string }[] }): string {
	return result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
}

function searchAction(query: string, path: string): ExplorationAction {
	return {
		kind: "search",
		title: "Search",
		body: path && path !== "." ? `${query} in ${path}` : query,
	};
}

function findAction(query: string, path: string): ExplorationAction {
	return {
		kind: "find",
		title: "Find",
		body: path && path !== "." ? `${query} in ${path}` : query,
	};
}

function renderExploreCall(action: ExplorationAction, theme: any, context: any): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(renderExplorationCall(action, theme, context));
	return text;
}

function shouldHideSearchResult(options: { expanded?: boolean }, context: any): boolean {
	return !context?.isError && (!options.expanded || isExplorationHidden(context?.toolCallId));
}

function renderGutterBlock(lines: string[], theme: any): string {
	const body = lines.length > 0 ? lines : [theme.fg("muted", "(no output)")];
	return body
		.map((line, index) => {
			const prefix = index === body.length - 1 ? "  └ " : index === 0 ? "  ├ " : "  │ ";
			return `${theme.fg("dim", prefix)}${line}`;
		})
		.join("\n");
}

function limitRenderedLines(lines: string[], options: { expanded?: boolean }, maxLines: number, theme: any): string[] {
	if (options.expanded || lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), theme.fg("muted", `... (${lines.length - maxLines} more lines)`)];
}

function isNoticeLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function renderFindOutputLines(output: string, theme: any): string[] {
	if (!output || output === "No files found matching pattern") {
		return [theme.fg("muted", "No files found matching pattern")];
	}

	const groups = new Map<string, string[]>();
	const notices: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (isNoticeLine(line)) {
			notices.push(theme.fg("muted", line));
			continue;
		}
		const dir = path.posix.dirname(line);
		const file = path.posix.basename(line);
		const key = dir === "." ? "." : dir;
		const files = groups.get(key) ?? [];
		files.push(file);
		groups.set(key, files);
	}

	const lines: string[] = [];
	for (const [dir, files] of groups) {
		if (lines.length > 0) lines.push("");
		const label = dir === "." ? "./" : `${dir}/`;
		lines.push(theme.fg("accent", label));
		files.forEach((file, index) => {
			const branch = index === files.length - 1 ? "└ " : "├ ";
			lines.push(`  ${theme.fg("dim", branch)}${theme.fg("toolOutput", file)}`);
		});
	}
	if (notices.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...notices);
	}
	return lines;
}

type HighlightMode = "literal" | "regex";

function renderGrepOutputLines(
	output: string,
	patterns: string[],
	theme: any,
	mode: HighlightMode = "literal",
): string[] {
	if (!output || output === "No matches found") {
		return [theme.fg("muted", "No matches found")];
	}

	const lines: string[] = [];
	let currentFile = "";
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) {
			lines.push("");
			continue;
		}
		if (isNoticeLine(line)) {
			lines.push(theme.fg("muted", line));
			continue;
		}

		const match = line.match(/^(.+?)([:-])(\d+)\2\s?(.*)$/);
		if (!match) {
			lines.push(theme.fg("toolOutput", line));
			continue;
		}

		const [, file, separator, lineNumber, content] = match;
		if (file !== currentFile) {
			if (currentFile) lines.push("");
			lines.push(theme.fg("accent", file));
			currentFile = file;
		}

		const paddedLineNumber = lineNumber.padStart(4, " ");
		const lineNumberText = theme.fg(separator === ":" ? "success" : "muted", paddedLineNumber);
		const body = highlightPatterns(content, patterns, theme, mode);
		lines.push(`  ${lineNumberText} ${theme.fg("dim", "│")} ${body}`);
	}
	return lines;
}

function highlightPatterns(text: string, patterns: string[], theme: any, mode: HighlightMode): string {
	const usablePatterns = patterns.filter((pattern) => pattern.length > 0);
	if (usablePatterns.length === 0) return theme.fg("toolOutput", text);

	try {
		const regex =
			mode === "regex"
				? new RegExp(usablePatterns.join("|"), "gi")
				: new RegExp(
						usablePatterns
							.sort((a, b) => b.length - a.length)
							.map(escapeRegex)
							.join("|"),
						"gi",
					);
		let lastIndex = 0;
		let highlighted = "";
		for (const match of text.matchAll(regex)) {
			const index = match.index ?? 0;
			if (match[0].length === 0) continue;
			highlighted += theme.fg("toolOutput", text.slice(lastIndex, index));
			highlighted += theme.bold(theme.fg("warning", match[0]));
			lastIndex = index + match[0].length;
		}
		highlighted += theme.fg("toolOutput", text.slice(lastIndex));
		return highlighted;
	} catch {
		return theme.fg("toolOutput", text);
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toFffPath(value: string): string {
	return value.split(path.sep).join("/");
}

function normalizePathConstraint(rawPath: string | undefined, cwd: string): string | undefined {
	const trimmed = rawPath?.trim();
	if (!trimmed) return undefined;

	const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
	const relativePath = path.isAbsolute(trimmed) ? path.relative(cwd, absolutePath) : trimmed;

	if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath) && existsSync(absolutePath)) {
		const normalized = toFffPath(relativePath);
		return statSync(absolutePath).isDirectory() && !normalized.endsWith("/") ? `${normalized}/` : normalized;
	}

	return toFffPath(trimmed);
}

function normalizeConstraintExpression(rawConstraints: string | undefined, cwd: string): string | undefined {
	const trimmed = rawConstraints?.trim();
	if (!trimmed) return undefined;

	return trimmed
		.split(/\s+/)
		.map((constraint) => {
			const negated = constraint.startsWith("!");
			const value = negated ? constraint.slice(1) : constraint;
			const normalized = normalizePathConstraint(value, cwd) ?? value;
			return negated ? `!${normalized}` : normalized;
		})
		.join(" ");
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) return null;

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			return options.signal.aborted || items.length === 0 ? null : { items, prefix };
		},
		applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = _lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const newLine = before + item.value + after;
			const newCursorCol = cursorCol - prefix.length + item.value.length;
			return {
				lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: newCursorCol,
			};
		},
	};
}

// Simple editor wrapper that injects FFF @-mention autocomplete alongside base provider
class FffEditor extends CustomEditor {
	private baseProvider: AutocompleteProvider | undefined;
	private getMentionItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>;

	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		getMentionItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
	) {
		super(tui, theme, keybindings);
		this.getMentionItems = getMentionItems;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.baseProvider = provider;
		// Create composite provider that handles @-mentions and falls back to base
		const mentionProvider = createFffMentionProvider(this.getMentionItems);
		const compositeProvider: AutocompleteProvider = {
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				// Try @-mention first
				const mentionResult = await mentionProvider.getSuggestions(lines, cursorLine, cursorCol, options);
				if (mentionResult) return mentionResult;
				// Fall back to base provider
				return this.baseProvider?.getSuggestions(lines, cursorLine, cursorCol, options) ?? null;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				// Let mention provider handle @ completions, base provider for others
				if (prefix?.startsWith("@")) {
					return mentionProvider.applyCompletion!(lines, cursorLine, cursorCol, item, prefix);
				}
				return (
					this.baseProvider?.applyCompletion?.(lines, cursorLine, cursorCol, item, prefix) ?? {
						lines,
						cursorLine,
						cursorCol,
					}
				);
			},
		};
		super.setAutocompleteProvider(compositeProvider);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
	let finder: FileFinder | null = null;
	let finderCwd: string | null = null;
	let activeCwd = process.cwd();

	// Mode resolution: flag > env > default
	let currentMode =
		(pi.getFlag("fff-mode") as FffMode | undefined) ??
		(process.env.PI_FFF_MODE as FffMode | undefined) ??
		"tools-and-ui";

	const toolNames = resolveToolNames(currentMode);
	registerExplorationTool(toolNames.grep, (args) => {
		const pattern =
			args && typeof args === "object" && "pattern" in args && typeof args.pattern === "string" ? args.pattern : "";
		const path =
			args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : ".";
		return searchAction(pattern, path);
	});
	registerExplorationTool(toolNames.find, (args) => {
		const pattern =
			args && typeof args === "object" && "pattern" in args && typeof args.pattern === "string" ? args.pattern : "";
		const path =
			args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : ".";
		return findAction(pattern, path);
	});
	registerExplorationTool(toolNames.multiGrep, (args) => {
		const patterns =
			args && typeof args === "object" && "patterns" in args && Array.isArray(args.patterns)
				? args.patterns.filter((pattern): pattern is string => typeof pattern === "string")
				: [];
		const constraints =
			args && typeof args === "object" && "constraints" in args && typeof args.constraints === "string"
				? args.constraints
				: ".";
		return searchAction(patterns.map((pattern) => `"${pattern}"`).join(", "), constraints);
	});
	registerExplorationEventHandlers(pi);

	// DB path resolution: flag > env > undefined (use fff-node defaults)
	const frecencyDbPath =
		(pi.getFlag("fff-frecency-db") as string | undefined) ?? process.env.FFF_FRECENCY_DB ?? undefined;
	const historyDbPath =
		(pi.getFlag("fff-history-db") as string | undefined) ?? process.env.FFF_HISTORY_DB ?? undefined;

	function getMode(): FffMode {
		return currentMode;
	}

	function setMode(mode: FffMode): void {
		currentMode = mode;
	}

	function shouldEnableMentions(): boolean {
		return currentMode !== "tools-only";
	}

	async function createFinder(cwd: string): Promise<FileFinder> {
		const { FileFinder } = await loadFffNodeModule();
		const result = FileFinder.create({
			basePath: cwd,
			frecencyDbPath,
			historyDbPath,
			// Pi is a long-lived TUI process; keep FFF as an on-demand query engine
			// instead of leaving native watcher/content-index background threads alive.
			disableWatch: true,
			disableContentIndexing: true,
			disableMmapCache: true,
			aiMode: true,
		});

		if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`);

		const nextFinder = result.value;
		await nextFinder.waitForScan(15000);
		return nextFinder;
	}

	async function ensureFinder(cwd: string): Promise<FileFinder> {
		if (finder && !finder.isDestroyed && finderCwd === cwd) return finder;
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
			finderCwd = null;
		}

		finder = await createFinder(cwd);
		finderCwd = cwd;
		return finder;
	}

	function destroyFinder() {
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
			finderCwd = null;
		}
	}

	async function getMentionItems(query: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
		if (signal.aborted) return [];
		const f = await ensureFinder(activeCwd);
		if (signal.aborted) return [];

		const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
		if (!result.ok) return [];

		return result.value.items.slice(0, MENTION_MAX_RESULTS).map((mixed: MixedItem) => {
			if (mixed.type === "directory") {
				return {
					value: buildAtCompletionValue(mixed.item.relativePath),
					label: mixed.item.dirName,
					description: mixed.item.relativePath,
				};
			}
			return {
				value: buildAtCompletionValue(mixed.item.relativePath),
				label: mixed.item.fileName,
				description: mixed.item.relativePath,
			};
		});
	}

	function applyEditorMode(ctx: {
		ui: {
			getEditorComponent?: () => ((tui: any, theme: any, keybindings: any) => any) | undefined;
			setEditorComponent: (factory: ((tui: any, theme: any, keybindings: any) => any) | undefined) => void;
		};
	}) {
		if (!shouldEnableMentions()) {
			ctx.ui.setEditorComponent(undefined);
		} else if (ctx.ui.getEditorComponent?.()) {
			return;
		} else {
			ctx.ui.setEditorComponent(
				(tui: any, theme: any, keybindings: any) => new FffEditor(tui, theme, keybindings, getMentionItems),
			);
		}
	}

	// --- Flags / lifecycle ---

	pi.registerFlag("fff-mode", {
		description: "FFF mode: tools-and-ui | tools-only | override",
		type: "string",
	});

	pi.registerFlag("fff-frecency-db", {
		description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
		type: "string",
	});

	pi.registerFlag("fff-history-db", {
		description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			activeCwd = ctx.cwd;
			applyEditorMode(ctx);
		} catch (e: unknown) {
			ctx.ui.notify(`FFF init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		destroyFinder();
	});

	// --- grep tool ---

	const grepSchema = Type.Object({
		pattern: Type.String({
			description: "Search pattern (plain text or regex)",
		}),
		path: Type.Optional(
			Type.String({
				description: "Directory or file constraint, e.g. 'src/' or '*.ts' (default: project root)",
			}),
		),
		literal: Type.Optional(
			Type.Boolean({
				description: "Treat pattern as literal string instead of regex (default: true)",
			}),
		),
		context: Type.Optional(
			Type.Number({
				description: "Number of lines to show before and after each match (default: 0)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})`,
			}),
		),
		cursor: Type.Optional(
			Type.String({
				description: "Cursor from previous result for pagination",
			}),
		),
	});

	pi.registerTool({
		name: toolNames.grep,
		label: toolNames.grep,
		renderShell: "self",
		description: `Search file contents for a pattern using FFF (fast, frecency-ranked, git-aware). Returns matching lines with file paths and line numbers. Respects .gitignore. Supports plain text, regex, and fuzzy search modes. Smart case by default. Output truncated to ${DEFAULT_GREP_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Search file contents for patterns (FFF: frecency-ranked, git-aware, respects .gitignore)",
		promptGuidelines: [
			"Search for bare identifiers (e.g. 'InProgressQuote'), not code syntax or multi-token regex.",
			"Plain text search is faster and more reliable than regex. Prefer it.",
			"After 2 grep calls, read the top result file instead of grepping more.",
			"Use the path parameter for file/directory constraints: '*.ts', 'src/'.",
		],
		parameters: grepSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const f = await ensureFinder(activeCwd);
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
			const pathConstraint = normalizePathConstraint(params.path, activeCwd);
			const query = pathConstraint ? `${pathConstraint} ${params.pattern}` : params.pattern;
			const mode: GrepMode = params.literal === false ? "regex" : "plain";

			const grepResult = f.grep(query, {
				mode,
				smartCase: true,
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
				beforeContext: params.context ?? 0,
				afterContext: params.context ?? 0,
			});

			if (!grepResult.ok) throw new Error(grepResult.error);

			const result = grepResult.value;
			let output = formatGrepOutput(result, effectiveLimit);
			const truncation = truncateHead(output, {
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			output = truncation.content;

			const notices: string[] = [];
			if (result.items.length >= effectiveLimit)
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more`);
			if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			if (result.regexFallbackError) notices.push(`Regex failed: ${result.regexFallbackError}, used literal match`);
			if (result.nextCursor)
				notices.push(`More results available. Use cursor="${storeCursor(result.nextCursor)}" to continue`);

			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
					pattern: params.pattern,
					patterns: [params.pattern],
					matchMode: params.literal === false ? "regex" : "literal",
				},
			};
		},

		renderCall(args, theme, context) {
			const pattern = args?.pattern ?? "";
			const path = args?.path ?? ".";
			return renderExploreCall(searchAction(pattern, path), theme, context);
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (shouldHideSearchResult(options, context)) {
				text.setText("");
				return text;
			}
			const output = getResultText(result);
			const details = (result as any).details;
			const patterns = Array.isArray(details?.patterns)
				? details.patterns
				: typeof details?.pattern === "string"
					? [details.pattern]
					: [];
			const matchMode = details?.matchMode === "regex" ? "regex" : "literal";
			const lines = limitRenderedLines(
				renderGrepOutputLines(output, patterns, theme, matchMode),
				options,
				28,
				theme,
			);
			text.setText(renderGutterBlock(lines, theme));
			return text;
		},
	});

	// --- find tool ---

	const findSchema = Type.Object({
		pattern: Type.String({
			description: "Fuzzy search query for file names. Supports path prefixes ('src/') and globs ('*.ts').",
		}),
		path: Type.Optional(
			Type.String({
				description: "Directory to search in (default: project root)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})`,
			}),
		),
	});

	pi.registerTool({
		name: toolNames.find,
		label: toolNames.find,
		renderShell: "self",
		description: `Fuzzy file search by name using FFF (fast, frecency-ranked, git-aware). Returns matching file paths relative to project root. Respects .gitignore. Supports fuzzy matching, path prefixes ('src/'), and glob constraints ('*.ts', '**/*.spec.ts'). Output truncated to ${DEFAULT_FIND_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,
		promptSnippet: "Find files by name (FFF: fuzzy, frecency-ranked, git-aware, respects .gitignore)",
		promptGuidelines: [
			"Keep queries short -- prefer 1-2 terms max.",
			"Multiple words narrow results (waterfall), they are not OR.",
			"Use this to find files by name. Use grep to search file contents.",
		],
		parameters: findSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const f = await ensureFinder(activeCwd);
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
			const query = params.path ? `${params.path} ${params.pattern}` : params.pattern;

			const searchResult = f.fileSearch(query, { pageSize: effectiveLimit });
			if (!searchResult.ok) throw new Error(searchResult.error);

			const result = searchResult.value;
			let output = formatFindOutput(result, effectiveLimit);
			const truncation = truncateHead(output, {
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			output = truncation.content;

			const notices: string[] = [];
			if (result.items.length >= effectiveLimit)
				notices.push(
					`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
			if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			if (result.totalMatched > result.items.length)
				notices.push(`${result.totalMatched} total matches (${result.totalFiles} indexed files)`);

			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
					pattern: params.pattern,
				},
			};
		},

		renderCall(args, theme, context) {
			const pattern = args?.pattern ?? "";
			const path = args?.path ?? ".";
			return renderExploreCall(findAction(pattern, path), theme, context);
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (shouldHideSearchResult(options, context)) {
				text.setText("");
				return text;
			}
			const output = getResultText(result);
			const lines = limitRenderedLines(renderFindOutputLines(output, theme), options, 32, theme);
			text.setText(renderGutterBlock(lines, theme));
			return text;
		},
	});

	// --- multi_grep tool ---

	const multiGrepSchema = Type.Object({
		patterns: Type.Array(Type.String(), {
			description:
				"Patterns to search for (OR logic -- matches lines containing ANY pattern). Include all naming conventions: snake_case, PascalCase, camelCase.",
		}),
		constraints: Type.Optional(
			Type.String({
				description: "File constraints, e.g. '*.{ts,tsx} !test/' to filter files. Separate from patterns.",
			}),
		),
		context: Type.Optional(
			Type.Number({
				description: "Number of context lines before and after each match (default: 0)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})`,
			}),
		),
		cursor: Type.Optional(
			Type.String({
				description: "Cursor from previous result for pagination",
			}),
		),
	});

	pi.registerTool({
		name: toolNames.multiGrep,
		label: toolNames.multiGrep,
		renderShell: "self",
		description:
			"Search file contents for lines matching ANY of multiple patterns (OR logic). Uses SIMD-accelerated Aho-Corasick multi-pattern matching. Faster than regex alternation. Patterns are literal text -- never escape special characters. Use the constraints parameter for file filtering ('*.rs', 'src/', '!test/').",
		promptSnippet: "Multi-pattern OR search across file contents (FFF: SIMD-accelerated, frecency-ranked)",
		promptGuidelines: [
			`Use ${toolNames.multiGrep} when you need to find multiple identifiers at once (OR logic).`,
			"Include all naming conventions: snake_case, PascalCase, camelCase variants.",
			"Patterns are literal text. Never escape special characters.",
			"Use the constraints parameter for file type/path filtering, not inside patterns.",
		],
		parameters: multiGrepSchema,

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!params.patterns?.length) throw new Error("patterns array must have at least 1 element");

			const f = await ensureFinder(activeCwd);
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

			const grepResult = f.multiGrep({
				patterns: params.patterns,
				constraints: normalizeConstraintExpression(params.constraints, activeCwd),
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				smartCase: true,
				cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
				beforeContext: params.context ?? 0,
				afterContext: params.context ?? 0,
			});

			if (!grepResult.ok) throw new Error(grepResult.error);

			const result = grepResult.value;
			let output = formatGrepOutput(result, effectiveLimit);
			const truncation = truncateHead(output, {
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			output = truncation.content;

			const notices: string[] = [];
			if (result.items.length >= effectiveLimit)
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more`);
			if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			if (result.nextCursor)
				notices.push(`More results available. Use cursor="${storeCursor(result.nextCursor)}" to continue`);

			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					truncated: truncation.truncated,
					patterns: params.patterns,
				},
			};
		},

		renderCall(args, theme, context) {
			const patterns = args?.patterns ?? [];
			return renderExploreCall(
				searchAction(patterns.map((p: string) => `"${p}"`).join(", "), args?.constraints ?? "."),
				theme,
				context,
			);
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (shouldHideSearchResult(options, context)) {
				text.setText("");
				return text;
			}
			const output = getResultText(result);
			const patterns = Array.isArray((result as any).details?.patterns) ? (result as any).details.patterns : [];
			const lines = limitRenderedLines(
				renderGrepOutputLines(output, patterns, theme, "literal"),
				options,
				28,
				theme,
			);
			text.setText(renderGutterBlock(lines, theme));
			return text;
		},
	});

	// --- commands ---

	pi.registerCommand("fff-mode", {
		description: "Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim();

			// No args - show current mode
			if (!arg) {
				const mode = getMode();
				const flag = pi.getFlag("fff-mode") ?? "unset";
				const env = process.env.PI_FFF_MODE ?? "unset";
				ctx.ui.notify(`Current mode: '${mode}'\nFlag: ${flag}, Env: ${env}`, "info");
				return;
			}

			// Validate and set mode
			if (!VALID_MODES.includes(arg as FffMode)) {
				ctx.ui.notify(`Usage: /fff-mode [${VALID_MODES.join(" | ")}]`, "warning");
				return;
			}

			const newMode = arg as FffMode;
			const oldMode = getMode();
			setMode(newMode);

			// Apply immediately using the shared function
			applyEditorMode(ctx);

			const note =
				(oldMode === "override") !== (newMode === "override") ? " (tool name change requires restart)" : "";
			ctx.ui.notify(`Mode changed: '${oldMode}' → '${newMode}'${note}`, "info");
		},
	});

	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and status",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const health = finder.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`Health check failed: ${health.error}`, "error");
				return;
			}

			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Mode: ${getMode()}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
			];

			const progress = finder.getScanProgress();
			if (progress.ok) {
				lines.push(
					`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const result = finder.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
