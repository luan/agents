import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";
import { chip, color, compactLocations, okLine, renderText, title, warnLine } from "../shared/ct-render.ts";

type SourceDetails = {
	operation: string;
	command: string;
	cwd: string;
	exitCode: number;
	results: unknown;
	stdout: string;
	stderr: string;
};

const commonOptions = {
	db: Type.Optional(Type.String({ description: "Override source database path" })),
};

const targetList = Type.Array(Type.String({ description: "Symbol target" }), {
	description: "Symbols to analyze",
});

const sourceShowTargetList = Type.Array(Type.String({ description: "Symbol target" }), {
	description: "Symbols to resolve; use file:symbol for file hints.",
});

const sourceSearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query; structural mode may use pattern instead" })),
	mode: Type.Optional(Type.Union([Type.Literal("symbol"), Type.Literal("text"), Type.Literal("path"), Type.Literal("structural")], { description: "Search mode" })),
	pattern: Type.Optional(Type.String({ description: "Structural AST pattern; defaults to query" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results to return" })),
	kind: Type.Optional(Type.String({ description: "Symbol kind filter" })),
	lang: Type.Optional(Type.String({ description: "Language filter; required for structural mode" })),
	exact: Type.Optional(Type.Boolean({ description: "Require exact matching where supported" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching where supported" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	selector: Type.Optional(Type.String({ description: "ast-grep selector for structural mode" })),
	context: Type.Optional(Type.Number({ description: "Context lines for structural matches" })),
	includeIgnored: Type.Optional(Type.Boolean({ description: "Include ignored files where supported" })),
	...commonOptions,
});

const sourceTargetsSchema = Type.Object({
	targets: targetList,
	...commonOptions,
});

const sourceShowSchema = Type.Object({
	targets: sourceShowTargetList,
	all: Type.Optional(Type.Boolean({ description: "Return every definition for ambiguous targets" })),
	...commonOptions,
});

const sourceOutlineSchema = Type.Object({
	file: Type.String({ description: "File to outline" }),
	signatures: Type.Optional(Type.Boolean({ description: "Include signatures" })),
	names: Type.Optional(Type.Boolean({ description: "Only return names" })),
	...commonOptions,
});

const sourceRefsSchema = Type.Object({
	targets: targetList,
	importers: Type.Optional(Type.Boolean({ description: "Also include importers" })),
	impact: Type.Optional(Type.Boolean({ description: "Include shallow impact" })),
	depth: Type.Optional(Type.Number({ description: "Reference/importer depth" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	context: Type.Optional(Type.Number({ description: "Context lines around references" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	file: Type.Optional(Type.String({ description: "Limit references to paths containing this fragment" })),
	...commonOptions,
});

const sourceGraphSchema = Type.Object({
	targets: targetList,
	depth: Type.Optional(Type.Number({ description: "Traversal depth" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	context: Type.Optional(Type.Number({ description: "Context lines around hits; impact only" })),
	kinds: Type.Optional(Type.String({ description: "Trace edge kinds, e.g. call or call,use" })),
	...commonOptions,
});

const sourceImplsSchema = Type.Object({
	targets: targetList,
	lang: Type.Optional(Type.String({ description: "Language filter" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
	paths: Type.Optional(Type.Array(Type.String({ description: "Include globs" }))),
	excludes: Type.Optional(Type.Array(Type.String({ description: "Exclude globs" }))),
	of: Type.Optional(Type.String({ description: "Find protocols/interfaces implemented by this symbol" })),
	resolved: Type.Optional(Type.Boolean({ description: "Only include resolved implementation targets" })),
	unresolved: Type.Optional(Type.Boolean({ description: "Only include unresolved implementation targets" })),
	...commonOptions,
});

const sourceDiffSchema = Type.Object({
	target: Type.String({ description: "Symbol whose definition-scoped diff should be shown" }),
	base: Type.Optional(Type.String({ description: "Base ref" })),
	stat: Type.Optional(Type.Boolean({ description: "Return diffstat instead of full diff" })),
	...commonOptions,
});

function pushFlag(args: string[], enabled: unknown, flag: string) {
	if (enabled === true) args.push(flag);
}

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null) args.push(flag, String(value));
}

function pushMany(args: string[], flag: string, values: unknown) {
	if (!Array.isArray(values)) return;
	for (const value of values) args.push(flag, String(value));
}

async function runSource(operation: string, subcommand: string, args: string[], cwd: string, signal?: AbortSignal, db?: string) {
	const fullArgs = ["source", subcommand, "--json"];
	if (db) fullArgs.push("--db", db);
	fullArgs.push(...args);
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const results = JSON.parse(result.stdout);
	const command = formatCommand("ct", fullArgs);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
		details: {
			operation,
			command,
			cwd,
			exitCode: result.exitCode,
			results,
			stdout: result.stdout,
			stderr: result.stderr,
		} satisfies SourceDetails,
	};
}

function truncate(text: string, max = 96): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function relPath(item: any): string | undefined {
	return item?.rel_path ?? item?.path ?? item?.file;
}

function resultCount(results: unknown): number | undefined {
	if (Array.isArray(results)) return results.length;
	if (results && typeof results === "object") {
		const obj = results as Record<string, unknown>;
		for (const key of ["results", "symbols", "references", "items", "matches", "callers", "entries"]) {
			if (Array.isArray(obj[key])) return obj[key].length;
		}
	}
	return undefined;
}

function summarize(details: SourceDetails | undefined, expanded: boolean, theme: any): string {
	if (!details) return "";
	const count = resultCount(details.results);
	const prefix = okLine(theme, [chip(theme, "󰓹", details.operation, count ?? "ok")]);
	const loc = compactLocations(details.results, 2);
	const suffix = loc ? `  ${color(theme, "muted", loc)}` : "";
	if (!expanded) return prefix + suffix;

	const lines = [prefix + suffix];
	const results = details.results;
	if (Array.isArray(results)) {
		for (const item of results.slice(0, 20)) {
			if (item && typeof item === "object") {
				const anyItem = item as any;
				const name = anyItem.name ?? anyItem.target ?? anyItem.symbol ?? anyItem.kind ?? "result";
				const kind = anyItem.kind ? theme.fg("muted", ` ${anyItem.kind}`) : "";
				const path = relPath(anyItem);
				const loc = path ? theme.fg("dim", ` ${path}${anyItem.start_line ? `:${anyItem.start_line}` : ""}`) : "";
				lines.push(`  ${theme.fg("accent", String(name))}${kind}${loc}`);
			} else {
				lines.push(`  ${theme.fg("toolOutput", truncate(String(item)))}`);
			}
		}
		if (results.length > 20) lines.push(theme.fg("muted", `  … ${results.length - 20} more`));
		return lines.join("\n");
	}

	const text = JSON.stringify(results, null, 2);
	for (const line of text.split("\n").slice(0, 40)) lines.push(theme.fg("toolOutput", line));
	return lines.join("\n");
}

function renderSourceCall(operation: string, target: string | undefined, theme: any, ctx: any) {
	return renderText(ctx, title(theme, "󰓹", `source ${operation}`, target ? truncate(target) : ""));
}

function renderResult(result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any, ctx: any) {
	if (options.isPartial) return renderText(ctx, warnLine(theme, [chip(theme, "󰓹", "source", "running…")]));
	return renderText(ctx, summarize(result.details as SourceDetails | undefined, options.expanded === true, theme));
}

export default function sourceExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "source_search",
		label: "source search",
		description: "Search source by symbol, text, path, or structural AST pattern.",
		promptSnippet: "Use source_search for code search. Modes: symbol, text, path, structural.",
		promptGuidelines: ["Use source_search instead of grep/find or backend-specific search tools."],
		parameters: sourceSearchSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushOpt(args, "--mode", params.mode);
			pushOpt(args, "--pattern", params.pattern);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--kind", params.kind);
			pushOpt(args, "--lang", params.lang);
			pushFlag(args, params.exact, "--exact");
			pushFlag(args, params.ignoreCase, "--ignore-case");
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			pushOpt(args, "--selector", params.selector);
			pushOpt(args, "--context", params.context);
			pushFlag(args, params.includeIgnored, "--include-ignored");
			if (params.query) args.push(params.query);
			return runSource("source search", "search", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderText(ctx, title(theme, "󰓹", "source search", args.query ?? args.pattern ?? args.mode ?? "symbol")),
		renderResult,
	});

	registerTool({
		name: "source_show",
		label: "source show",
		description: "Resolve symbols to structured source metadata.",
		promptSnippet: "Use source_show to resolve symbols to structured metadata; use read for source lines.",
		promptGuidelines: ["Use source_show instead of backend-specific symbol display tools."],
		parameters: sourceShowSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushFlag(args, params.all, "--all");
			args.push(...params.targets);
			return runSource("source show", "show", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("show", args.targets?.join(", ") ?? "", theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_outline",
		label: "source outline",
		description: "List symbols defined in a source file.",
		promptSnippet: "Use source_outline before opening large or unfamiliar source files.",
		promptGuidelines: ["Use source_outline instead of backend-specific outline tools."],
		parameters: sourceOutlineSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushFlag(args, params.signatures, "--signatures");
			pushFlag(args, params.names, "--names");
			args.push(params.file);
			return runSource("source outline", "outline", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("outline", args.file, theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_investigate",
		label: "source investigate",
		description: "Resolve and inspect symbols with kind-adaptive context.",
		promptSnippet: "Use source_investigate before reading unfamiliar symbols.",
		promptGuidelines: ["Use source_investigate instead of backend-specific investigation tools."],
		parameters: sourceTargetsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runSource("source investigate", "investigate", [...params.targets], ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("investigate", args.targets?.join(", "), theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_refs",
		label: "source refs",
		description: "Find direct references to symbols.",
		promptSnippet: "Use source_refs to find direct references to symbols.",
		promptGuidelines: ["Use source_refs instead of backend-specific reference tools."],
		parameters: sourceRefsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushFlag(args, params.importers, "--importers");
			pushFlag(args, params.impact, "--impact");
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--context", params.context);
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			pushOpt(args, "--file", params.file);
			args.push(...params.targets);
			return runSource("source refs", "refs", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("refs", args.targets?.join(", "), theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_impact",
		label: "source impact",
		description: "Find transitive callers/dependents of symbols.",
		promptSnippet: "Use source_impact to trace who depends on a symbol.",
		promptGuidelines: ["Use source_impact instead of backend-specific impact tools."],
		parameters: sourceGraphSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--context", params.context);
			args.push(...params.targets);
			return runSource("source impact", "impact", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("impact", args.targets?.join(", "), theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_trace",
		label: "source trace",
		description: "Follow the call graph downward from symbols.",
		promptSnippet: "Use source_trace to trace what a symbol calls.",
		promptGuidelines: ["Use source_trace instead of backend-specific trace tools."],
		parameters: sourceGraphSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushOpt(args, "--depth", params.depth);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--kinds", params.kinds);
			args.push(...params.targets);
			return runSource("source trace", "trace", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("trace", args.targets?.join(", "), theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_impls",
		label: "source impls",
		description: "Find types that implement/extend/conform to symbols.",
		promptSnippet: "Use source_impls to find implementations or conformances for a type/interface.",
		promptGuidelines: ["Use source_impls instead of backend-specific implementation tools."],
		parameters: sourceImplsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushOpt(args, "--lang", params.lang);
			pushOpt(args, "--limit", params.limit);
			pushMany(args, "--path", params.paths);
			pushMany(args, "--exclude", params.excludes);
			pushOpt(args, "--of", params.of);
			pushFlag(args, params.resolved, "--resolved");
			pushFlag(args, params.unresolved, "--unresolved");
			args.push(...params.targets);
			return runSource("source impls", "impls", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("impls", args.targets?.join(", "), theme, ctx),
		renderResult,
	});

	registerTool({
		name: "source_diff",
		label: "source diff",
		description: "Return git diff scoped to a symbol definition.",
		promptSnippet: "Use source_diff to show git diff scoped to a symbol definition.",
		promptGuidelines: ["Use source_diff instead of backend-specific symbol diff tools."],
		parameters: sourceDiffSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args: string[] = [];
			pushFlag(args, params.stat, "--stat");
			args.push(params.target);
			if (params.base) args.push(params.base);
			return runSource("source diff", "diff", args, ctx.cwd, signal, params.db);
		},
		renderCall: (args, theme, ctx) => renderSourceCall("diff", args.target, theme, ctx),
		renderResult,
	});
}
