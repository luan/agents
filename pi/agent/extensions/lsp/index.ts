import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";

const requestSchema = Type.Object({
	operation: Type.String({ description: "LSP operation" }),
	filePath: Type.Optional(Type.String({ description: "File path" })),
	line: Type.Optional(Type.Number({ description: "1-based line" })),
	character: Type.Optional(Type.Number({ description: "1-based character" })),
	query: Type.Optional(Type.String({ description: "Workspace symbol query" })),
	newName: Type.Optional(Type.String({ description: "Rename target" })),
});

const diagnosticsSchema = Type.Object({
	filePath: Type.String({ description: "File path" }),
});

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null) args.push(flag, String(value));
}

async function runCtLsp(args: string[], cwd: string, signal?: AbortSignal) {
	const fullArgs = ["lsp", ...args, "--json"];
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const parsed = JSON.parse(result.stdout);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
		details: { command: formatCommand("ct", fullArgs), cwd, results: parsed, stdout: result.stdout, stderr: result.stderr },
	};
}

export default function lspExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "lsp_navigation",
		label: "lsp navigation",
		description: "Navigate code using ct lsp.",
		parameters: requestSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["request", "--operation", params.operation];
			pushOpt(args, "--file-path", params.filePath);
			pushOpt(args, "--line", params.line);
			pushOpt(args, "--character", params.character);
			pushOpt(args, "--query", params.query);
			pushOpt(args, "--new-name", params.newName);
			return runCtLsp(args, ctx.cwd, signal);
		},
	});

	registerTool({
		name: "lsp_diagnostics",
		label: "lsp diagnostics",
		description: "Collect and store LSP diagnostics through ct lsp.",
		parameters: diagnosticsSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runCtLsp(["diagnostics", "--file-path", params.filePath], ctx.cwd, signal);
		},
	});
}
