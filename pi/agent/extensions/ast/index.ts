import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";
import { compactLocations, nf, renderText, resultCount, toolResult } from "../shared/ct-render.ts";
import { recordLensReadsFromAstMatches } from "../shared/lens-read.ts";

const paths = Type.Optional(Type.Array(Type.String({ description: "Files or directories to search" })));

const searchSchema = Type.Object({
	pattern: Type.String({ description: "AST pattern" }),
	lang: Type.String({ description: "Target language" }),
	paths,
	selector: Type.Optional(Type.String({ description: "ast-grep selector" })),
	context: Type.Optional(Type.Number({ description: "Context lines" })),
});

const replaceSchema = Type.Object({
	pattern: Type.String({ description: "AST pattern" }),
	rewrite: Type.String({ description: "Rewrite template" }),
	lang: Type.String({ description: "Target language" }),
	paths,
	apply: Type.Optional(Type.Boolean({ description: "Apply via ct patch draft/apply-patch" })),
});

function pushMany(args: string[], flag: string, values: unknown) {
	if (!Array.isArray(values)) return;
	for (const value of values) args.push(flag, String(value));
}

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null) args.push(flag, String(value));
}

async function runCtAst(args: string[], cwd: string, signal?: AbortSignal, session?: string) {
	const fullArgs = ["ast", ...args, "--json"];
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const parsed = JSON.parse(result.stdout);
	await recordLensReadsFromAstMatches(parsed, cwd, session, signal);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
		details: { command: formatCommand("ct", fullArgs), cwd, results: parsed, stdout: result.stdout, stderr: result.stderr },
	};
}

function sessionId(ctx: any): string | undefined {
	return ctx?.sessionManager?.getSessionId?.();
}

export default function astExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "ast_grep_search",
		label: "ast search",
		description: "Search code using native ct ast / ast-grep.",
		parameters: searchSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["search", "--lang", params.lang, "--pattern", params.pattern];
			pushMany(args, "--path", params.paths);
			pushOpt(args, "--selector", params.selector);
			pushOpt(args, "--context", params.context);
			return runCtAst(args, ctx.cwd, signal, sessionId(ctx));
		},
		renderCall(args, _theme, ctx) {
			const pathCount = Array.isArray(args.paths) ? args.paths.length : 1;
			return renderText(ctx, `${nf.ast} search ${args.lang}  ${nf.files} ${pathCount}`);
		},
		renderResult(result, _options, _theme, ctx) {
			const data = toolResult(result);
			return renderText(ctx, `${nf.ok} ${nf.ast} search ${resultCount(data)}${compactLocations(data.matches)}`);
		},
	});

	registerTool({
		name: "ast_grep_replace",
		label: "ast replace",
		description: "Replace code using native ct ast. Apply routes through ct patch drafts.",
		parameters: replaceSchema,
		executionMode: "exclusive",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["replace", "--lang", params.lang, "--pattern", params.pattern, "--rewrite", params.rewrite];
			pushMany(args, "--path", params.paths);
			if (params.apply === true) args.push("--apply");
			return runCtAst(args, ctx.cwd, signal, sessionId(ctx));
		},
		renderCall(args, _theme, ctx) {
			const mode = args.apply === true ? `${nf.apply} apply` : `${nf.dryRun} dry`;
			return renderText(ctx, `${nf.ast} replace ${args.lang}  ${mode}`);
		},
		renderResult(result, _options, _theme, ctx) {
			const data = toolResult(result);
			return renderText(ctx, `${nf.ok} ${nf.ast} replace ${resultCount(data)}${compactLocations(data.matches)}`);
		},
	});
}
