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
}
