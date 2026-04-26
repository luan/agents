import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";

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

async function runCtAst(args: string[], cwd: string, signal?: AbortSignal) {
	const fullArgs = ["ast", ...args, "--json"];
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const parsed = JSON.parse(result.stdout);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
		details: { command: formatCommand("ct", fullArgs), cwd, results: parsed, stdout: result.stdout, stderr: result.stderr },
	};
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
			return runCtAst(args, ctx.cwd, signal);
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
			return runCtAst(args, ctx.cwd, signal);
		},
	});
}
