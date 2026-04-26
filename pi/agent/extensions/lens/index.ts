import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";

const statusSchema = Type.Object({});
const readSchema = Type.Object({
	path: Type.String({ description: "Path read" }),
	startLine: Type.Number({ description: "Start line" }),
	endLine: Type.Number({ description: "End line" }),
	session: Type.Optional(Type.String({ description: "Session id" })),
});
const guardSchema = Type.Object({
	path: Type.String({ description: "Path to edit" }),
	startLine: Type.Number({ description: "Start line" }),
	endLine: Type.Number({ description: "End line" }),
	session: Type.Optional(Type.String({ description: "Session id" })),
	mode: Type.Optional(Type.String({ description: "off, warn, or block" })),
});
const diagnosticsListSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Optional path filter" })),
});
const diagnosticsRecordSchema = Type.Object({
	source: Type.String({ description: "Diagnostic source" }),
	severity: Type.String({ description: "error, warning, info, or hint" }),
	path: Type.Optional(Type.String({ description: "Path for the diagnostic" })),
	code: Type.Optional(Type.String({ description: "Diagnostic code" })),
	message: Type.String({ description: "Diagnostic message" }),
	startLine: Type.Optional(Type.Number({ description: "Start line" })),
	endLine: Type.Optional(Type.Number({ description: "End line" })),
	fingerprint: Type.Optional(Type.String({ description: "Stable fingerprint" })),
});

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null) args.push(flag, String(value));
}

async function runCtLens(args: string[], cwd: string, signal?: AbortSignal) {
	const fullArgs = ["lens", ...args, "--json"];
	const result = await runCommand("ct", fullArgs, cwd, signal);
	const parsed = JSON.parse(result.stdout);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
		details: { command: formatCommand("ct", fullArgs), cwd, results: parsed, stdout: result.stdout, stderr: result.stderr },
	};
}

export default function lensExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;

	registerTool({
		name: "lens_status",
		label: "lens status",
		description: "Show ct lens state status.",
		parameters: statusSchema,
		executionMode: "parallel",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return runCtLens(["status"], ctx.cwd, signal);
		},
	});

	registerTool({
		name: "lens_read_record",
		label: "lens read record",
		description: "Record read coverage for ct lens guard.",
		parameters: readSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["read", "record", "--path", params.path, "--start-line", String(params.startLine), "--end-line", String(params.endLine)];
			pushOpt(args, "--session", params.session);
			return runCtLens(args, ctx.cwd, signal);
		},
	});

	registerTool({
		name: "lens_guard_check",
		label: "lens guard check",
		description: "Check whether an edit range is covered by read-before-edit state.",
		parameters: guardSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["guard", "check", "--path", params.path, "--start-line", String(params.startLine), "--end-line", String(params.endLine)];
			pushOpt(args, "--session", params.session);
			pushOpt(args, "--mode", params.mode);
			return runCtLens(args, ctx.cwd, signal);
		},
	});

	registerTool({
		name: "lens_diagnostics_list",
		label: "lens diagnostics list",
		description: "List diagnostics stored in ct lens.",
		parameters: diagnosticsListSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["diagnostics", "list"];
			pushOpt(args, "--path", params.path);
			return runCtLens(args, ctx.cwd, signal);
		},
	});

	registerTool({
		name: "lens_diagnostics_record",
		label: "lens diagnostics record",
		description: "Record one diagnostic in ct lens.",
		parameters: diagnosticsRecordSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["diagnostics", "record", "--source", params.source, "--severity", params.severity, "--message", params.message];
			pushOpt(args, "--path", params.path);
			pushOpt(args, "--code", params.code);
			pushOpt(args, "--start-line", params.startLine);
			pushOpt(args, "--end-line", params.endLine);
			pushOpt(args, "--fingerprint", params.fingerprint);
			return runCtLens(args, ctx.cwd, signal);
		},
	});
}
