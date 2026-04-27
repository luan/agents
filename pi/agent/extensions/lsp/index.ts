import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";
import { chip, color, compactLocations, nf, okLine, renderText, resultCount, title, toolResult, warnLine } from "../shared/ct-render.ts";
import { recordLensRead } from "../shared/lens-read.ts";

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

function sessionId(ctx: any): string | undefined {
	return ctx?.sessionManager?.getSessionId?.();
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
			const result = await runCtLsp(args, ctx.cwd, signal);
			if (params.filePath && typeof params.line === "number") {
				await recordLensRead({ cwd: ctx.cwd, path: params.filePath, startLine: params.line, endLine: params.line, session: sessionId(ctx), signal });
			}
			return result;
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lsp, args.operation, args.filePath ?? ""));
		},
		renderResult(result, _options, theme, ctx) {
			const data = toolResult(result) as any;
			if (data.failureKind) return renderText(ctx, warnLine(theme, [chip(theme, nf.lsp, data.operation ?? "request", data.failureKind)]));
			const locations = compactLocations(data.result);
			return renderText(ctx, `${okLine(theme, [chip(theme, nf.lsp, data.operation ?? "request", resultCount(data))])}${locations ? `  ${color(theme, "muted", locations)}` : ""}`);
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
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, `${nf.lsp} ${nf.diagnostics}`, "diagnostics", args.filePath));
		},
		renderResult(result, _options, theme, ctx) {
			const data = toolResult(result) as any;
			if (data.failureKind) return renderText(ctx, warnLine(theme, [chip(theme, nf.diagnostics, "failed", data.failureKind)]));
			return renderText(ctx, okLine(theme, [chip(theme, nf.diagnostics, "diagnostics", data.resultCount ?? 0), chip(theme, nf.lens, "recorded", data.recordedDiagnostics ?? 0)]));
		},
	});
}
