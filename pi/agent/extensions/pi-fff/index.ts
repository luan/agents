/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and can also replace
 * @-mention autocomplete suggestions in the interactive editor.
 */

import type { GrepMode, MixedItem } from "@ff-labs/fff-node";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerExplorationEventHandlers, registerExplorationTool } from "../shared/exploration-rendering";
import { FffClient } from "./fff-client";
import {
	CursorStore,
	formatFindOutput,
	formatGrepOutput,
	normalizeConstraintExpression,
	normalizePathConstraint,
} from "./fff-format";
import { buildAtCompletionValue, FffEditor } from "./mention-provider";
import {
	findAction,
	getResultText,
	limitRenderedLines,
	renderExploreCall,
	renderFindOutputLines,
	renderGrepOutputLines,
	renderGutterBlock,
	searchAction,
	shouldHideSearchResult,
} from "./render";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 200;
const MENTION_MAX_RESULTS = 20;

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

const cursorStore = new CursorStore();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
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
	const fff = new FffClient({ frecencyDbPath, historyDbPath });

	function getMode(): FffMode {
		return currentMode;
	}

	function setMode(mode: FffMode): void {
		currentMode = mode;
	}

	function shouldEnableMentions(): boolean {
		return currentMode !== "tools-only";
	}

	async function getMentionItems(query: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
		if (signal.aborted) return [];
		const f = await fff.ensure(activeCwd);
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
		fff.destroy();
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

			const f = await fff.ensure(activeCwd);
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
			const pathConstraint = normalizePathConstraint(params.path, activeCwd);
			const query = pathConstraint ? `${pathConstraint} ${params.pattern}` : params.pattern;
			const mode: GrepMode = params.literal === false ? "regex" : "plain";

			const grepResult = f.grep(query, {
				mode,
				smartCase: true,
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				cursor: (params.cursor ? cursorStore.get(params.cursor) : null) ?? null,
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
				notices.push(`More results available. Use cursor="${cursorStore.store(result.nextCursor)}" to continue`);

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

			const f = await fff.ensure(activeCwd);
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

			const f = await fff.ensure(activeCwd);
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

			const grepResult = f.multiGrep({
				patterns: params.patterns,
				constraints: normalizeConstraintExpression(params.constraints, activeCwd),
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				smartCase: true,
				cursor: (params.cursor ? cursorStore.get(params.cursor) : null) ?? null,
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
				notices.push(`More results available. Use cursor="${cursorStore.store(result.nextCursor)}" to continue`);

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
			const finder = fff.currentFinder;
			if (!finder) {
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
			const finder = fff.currentFinder;
			if (!finder) {
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
