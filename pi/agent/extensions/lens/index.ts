import { StringEnum } from "@mariozechner/pi-ai";
import { basename } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";
import { nf, renderText, title } from "../shared/ct-render.ts";
import { renderLensCompactStatus, renderLensWidgetLines, summarizeLensResult } from "../shared/lens-ui.ts";

const HOOK_EVENT_SCHEMA = "lens.hook_event.v1";
const RAW_OUTPUT_MAX_BYTES = 256 * 1024;
type LensHookEventName = "session_start" | "context_injection" | "pre_tool" | "post_tool" | "turn_start" | "turn_end" | "agent_end" | "session_shutdown";

type ToolFile = {
	path: string;
	operation: string;
	start_line?: number;
	end_line?: number;
	generated?: boolean;
	include_ignored?: boolean;
};

const sessionTurnSchema = {
	session: Type.Optional(Type.String({ description: "Session id; defaults to current Pi session." })),
	turn: Type.Optional(Type.String({ description: "Turn id; defaults to current Pi turn." })),
};

const diagnosticsSchema = Type.Object({
	action: Type.Optional(StringEnum(["list", "record", "snapshot"] as const)),
	path: Type.Optional(Type.String({ description: "Optional path filter." })),
	all: Type.Optional(Type.Boolean({ description: "Show all diagnostics for list." })),
	source: Type.Optional(Type.String({ description: "Diagnostic source for record." })),
	scopeKind: Type.Optional(Type.String({ description: "Diagnostic scope kind." })),
	scopeKey: Type.Optional(Type.String({ description: "Diagnostic scope key." })),
	severity: Type.Optional(StringEnum(["error", "warning", "info", "hint"] as const)),
	code: Type.Optional(Type.String({ description: "Diagnostic code." })),
	message: Type.Optional(Type.String({ description: "Diagnostic message for record." })),
	startLine: Type.Optional(Type.Number({ description: "Start line." })),
	endLine: Type.Optional(Type.Number({ description: "End line." })),
	fingerprint: Type.Optional(Type.String({ description: "Stable diagnostic fingerprint." })),
	snapshot: Type.Optional(Type.Any({ description: "DiagnosticSnapshotInput JSON for snapshot." })),
});

const checksSchema = Type.Object({
	action: Type.Optional(StringEnum(["list", "run"] as const)),
	automatic: Type.Optional(Type.Boolean({ description: "Run only automatic checks/scanners." })),
	all: Type.Optional(Type.Boolean({ description: "Run all configured checks/scanners." })),
	name: Type.Optional(Type.Array(Type.String({ description: "Configured check/scanner name to run." }))),
	scanners: Type.Optional(Type.Boolean({ description: "Include configured scanners." })),
});

const statusSchema = Type.Object({});

const healthSchema = Type.Object({
	session: sessionTurnSchema.session,
	turn: sessionTurnSchema.turn,
	finalOutput: Type.Optional(Type.Boolean({ description: "Request final/agent-end style text for CLI parity." })),
});

const touchedSchema = Type.Object({
	session: sessionTurnSchema.session,
	turn: sessionTurnSchema.turn,
});

const cleanupSchema = Type.Object({
	session: Type.Optional(Type.String({ description: "Session id; defaults to current Pi session." })),
	turn: Type.Optional(Type.String({ description: "Turn id; defaults to current Pi turn." })),
	allowUnsafe: Type.Optional(Type.Boolean({ description: "Run unsafe/invasive registry entries explicitly." })),
});

const reportSchema = Type.Object({
	session: sessionTurnSchema.session,
	turn: sessionTurnSchema.turn,
	path: Type.Optional(Type.String({ description: "Optional changed-file path." })),
});

const contextSchema = Type.Object({
	session: sessionTurnSchema.session,
	turn: sessionTurnSchema.turn,
	ack: Type.Optional(Type.Boolean({ description: "Acknowledge current warning-or-worse health." })),
});

const rawOutputSchema = Type.Object({
	action: Type.Optional(StringEnum(["list", "show"] as const)),
	id: Type.Optional(Type.Number({ description: "Raw output id for show." })),
	limit: Type.Optional(Type.Number({ description: "Maximum outputs to list." })),
});

const pruneSchema = Type.Object({
	dryRun: Type.Optional(Type.Boolean({ description: "Preview retention pruning without deleting." })),
});

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null && value !== false) args.push(flag, String(value));
}

function pushBool(args: string[], flag: string, value: unknown) {
	if (value === true) args.push(flag);
}

type CommandRunner = typeof runCommand;

async function runCtLens(args: string[], cwd: string, signal?: AbortSignal, input?: string) {
	const fullArgs = ["lens", ...args, "--json"];
	const result = await runCommand("ct", fullArgs, cwd, { signal, input, allowNonZero: true });
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		if (result.exitCode !== 0) throw new Error(`${formatCommand("ct", fullArgs)} failed with exit code ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
		throw error;
	}
	return {
		content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
		details: { command: formatCommand("ct", fullArgs), cwd, results: parsed, stdout: result.stdout, stderr: result.stderr },
	};
}

export async function runLensHookCommand(
	name: string,
	event: Record<string, unknown>,
	cwd: string,
	options: { signal?: AbortSignal; runner?: CommandRunner } = {},
) {
	let result: CtHookCommandResult;
	try {
		result = await (options.runner ?? runCommand)("ct", ["hook", name], cwd, {
			signal: options.signal,
			input: JSON.stringify(event),
			allowNonZero: true,
		});
	} catch (error) {
		return hookFailureResponse("hook_command_failed", `ct hook failed to start: ${errorMessage(error)}`);
	}

	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		return hookFailureResponse("invalid_hook_response", hookFailureMessage(error, result), result);
	}
}

type CtHookCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function hookFailureResponse(code: string, message: string, result?: CtHookCommandResult) {
	return {
		schema_version: "lens.hook_response.v1",
		status: "degraded",
		decision: { outcome: "allow", reason: code },
		health: { status: "degraded", compact: "degraded · hook failed" },
		warnings: [],
		errors: [{ code, message }],
		data: result ? { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } : {},
	};
}

function hookFailureMessage(error: unknown, result: { stderr?: string; exitCode?: number }) {
	const stderr = result.stderr?.trim();
	const suffix = stderr ? `: ${stderr}` : `: ${String(error)}`;
	return `ct hook failed${typeof result.exitCode === "number" ? ` with exit code ${result.exitCode}` : ""}${suffix}`;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export default function lensExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;
	let sessionSeq = 0;
	let agentSeq = 0;
	let activeTurnIndex = 0;
	let activeTurnId = "turn-0-0";

	const isStaleCtxError = (error: unknown) =>
		(error instanceof Error ? error.message : String(error)).includes("ctx is stale");
	const safeCwd = (ctx: any) => {
		try {
			return ctx?.cwd ?? process.cwd();
		} catch (error) {
			if (isStaleCtxError(error)) return process.cwd();
			throw error;
		}
	};
	const safeSignal = (ctx: any) => {
		try {
			return ctx?.signal;
		} catch (error) {
			if (isStaleCtxError(error)) return undefined;
			throw error;
		}
	};
	const currentSession = (ctx: any) => {
		try {
			return ctx?.sessionManager?.getSessionId?.() ?? sessionIdFromFile(ctx) ?? "ephemeral";
		} catch (error) {
			if (isStaleCtxError(error)) return "ephemeral";
			throw error;
		}
	};
	const currentTurn = () => activeTurnId;

	async function runHook(name: string, event: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
		return runLensHookCommand(name, event, cwd, { signal });
	}

	function eventFor(ctx: any, event: LensHookEventName, extra: Record<string, unknown> = {}) {
		return {
			schema_version: HOOK_EVENT_SCHEMA,
			host: { name: "pi", kind: "extension" },
			session: { id: currentSession(ctx), seq: sessionSeq },
			cwd: safeCwd(ctx),
			turn: { id: currentTurn(), index: activeTurnIndex },
			event,
			known_files: [],
			...extra,
		};
	}

	function applyLensUi(ctx: any, response: unknown) {
		try {
			if (!ctx?.hasUI) return;
			ctx.ui.setStatus("lens", renderLensCompactStatus(response, { ansi: true }));
			ctx.ui.setWidget("lens-health", renderLensWidgetLines(response, false, { ansi: true }));
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
		}
	}

	async function ignoreStaleCtx<T>(task: () => Promise<T>): Promise<T | undefined> {
		try {
			return await task();
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await ignoreStaleCtx(async () => {
			sessionSeq++;
			agentSeq = 0;
			activeTurnIndex = 0;
			activeTurnId = "turn-0-0";
			const response = await runHook("lens-session-start", eventFor(ctx, "session_start"), safeCwd(ctx));
			applyLensUi(ctx, response);
		});
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		return ignoreStaleCtx(async () => {
			agentSeq++;
			activeTurnIndex = 0;
			activeTurnId = `turn-${agentSeq}-0`;
			const response = await runHook("lens-context", eventFor(ctx, "context_injection"), safeCwd(ctx), safeSignal(ctx));
			applyLensUi(ctx, response);
			if (response?.context?.inject === true && response.context.content) {
				return {
					message: {
						customType: "lens-context",
						content: response.context.content,
						display: false,
						details: response,
					},
				};
			}
		});
	});

	pi.on("turn_start", async (event, ctx) => {
		await ignoreStaleCtx(async () => {
			activeTurnIndex = Number.isFinite(event.turnIndex) ? event.turnIndex : activeTurnIndex;
			activeTurnId = `turn-${agentSeq}-${activeTurnIndex}`;
			const response = await runHook("lens-turn-start", eventFor(ctx, "turn_start"), safeCwd(ctx), safeSignal(ctx));
			applyLensUi(ctx, response);
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		await ignoreStaleCtx(async () => {
			const response = await runHook(
				"lens-pre-tool",
				eventFor(ctx, "pre_tool", {
					tool: { name: event.toolName, id: event.toolCallId, status: "started", input: event.input },
					known_files: filesFromTool(event.toolName, event.input),
				}),
				safeCwd(ctx),
				safeSignal(ctx),
			);
			applyLensUi(ctx, response);
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		await ignoreStaleCtx(async () => {
			const response = await runHook(
				"lens-post-tool",
				eventFor(ctx, "post_tool", {
					tool: {
						name: event.toolName,
						id: event.toolCallId,
						status: event.isError ? "error" : "success",
						input: event.input,
						output: event.details,
						raw_output: contentText(event.content),
						raw_output_max_bytes: RAW_OUTPUT_MAX_BYTES,
					},
					known_files: filesFromTool(event.toolName, event.input),
				}),
				safeCwd(ctx),
				safeSignal(ctx),
			);
			applyLensUi(ctx, response);
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		await ignoreStaleCtx(async () => {
			activeTurnIndex = Number.isFinite(event.turnIndex) ? event.turnIndex : activeTurnIndex;
			activeTurnId = `turn-${agentSeq}-${activeTurnIndex}`;
			const response = await runHook("lens-turn-end", eventFor(ctx, "turn_end"), safeCwd(ctx), safeSignal(ctx));
			applyLensUi(ctx, response);
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await ignoreStaleCtx(async () => {
			const response = await runHook("lens-agent-end", eventFor(ctx, "agent_end"), safeCwd(ctx), safeSignal(ctx));
			applyLensUi(ctx, response);
		});
	});

	registerTool({
		name: "lens_diagnostics",
		label: "Lens diagnostics",
		description: "List, record, or snapshot Lens diagnostics via ct lens diagnostics. Full JSON is preserved in details.",
		parameters: diagnosticsSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "list";
			if (action === "record") {
				const args = ["diagnostics", "record", "--source", required(params.source, "source"), "--severity", required(params.severity, "severity"), "--message", required(params.message, "message")];
				pushOpt(args, "--scope-kind", params.scopeKind);
				pushOpt(args, "--scope-key", params.scopeKey);
				pushOpt(args, "--path", params.path);
				pushOpt(args, "--code", params.code);
				pushOpt(args, "--start-line", params.startLine);
				pushOpt(args, "--end-line", params.endLine);
				pushOpt(args, "--fingerprint", params.fingerprint);
				return runCtLens(args, ctx.cwd, signal);
			}
			if (action === "snapshot") {
				return runCtLens(["diagnostics", "snapshot"], ctx.cwd, signal, JSON.stringify(required(params.snapshot, "snapshot")));
			}
			const args = ["diagnostics", "list"];
			pushOpt(args, "--path", params.path);
			pushBool(args, "--all", params.all);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.diagnostics, "lens diagnostics", args.action ?? "list"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_checks",
		label: "Lens checks",
		description: "List or run repository-configured Lens checks and scanners via ct lens checks.",
		parameters: checksSchema,
		executionMode: "exclusive",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "list";
			const args = ["checks", action];
			if (action === "run") {
				pushBool(args, "--automatic", params.automatic);
				pushBool(args, "--all", params.all);
				pushBool(args, "--scanners", params.scanners);
				for (const name of params.name ?? []) pushOpt(args, "--name", name);
			}
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens checks", args.action ?? "list"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_status",
		label: "Lens status",
		description: "Show repository Lens status via ct lens status.",
		parameters: statusSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, _params, signal, _onUpdate, ctx) {
			return runCtLens(["status"], ctx.cwd, signal);
		},
		renderCall(_args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens status"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_health",
		label: "Lens health",
		description: "Show turn-scoped Lens health via ct lens health.",
		parameters: healthSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["health", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()];
			pushBool(args, "--final-output", params.finalOutput);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(_args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens health", "turn"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_touched",
		label: "Lens touched",
		description: "List files touched during a turn via ct lens touched.",
		parameters: touchedSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runCtLens(["touched", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()], ctx.cwd, signal);
		},
		renderCall(_args, theme, ctx) {
			return renderText(ctx, title(theme, nf.files, "lens touched", "turn"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_cleanup",
		label: "Lens cleanup",
		description: "Run safe Lens turn-scoped cleanup via ct lens cleanup run.",
		parameters: cleanupSchema,
		executionMode: "exclusive",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["cleanup", "run", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()];
			pushBool(args, "--allow-unsafe", params.allowUnsafe);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens cleanup", args.allowUnsafe ? "allow unsafe" : "safe"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_report",
		label: "Lens report",
		description: "Show a deeper Lens changed-file report with diagnostics, cleanup, patch refs, and symbols.",
		parameters: reportSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["report", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()];
			pushOpt(args, "--path", params.path);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.files, "lens report", args.path ?? "turn"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_context",
		label: "Lens context",
		description: "Show or acknowledge action-forcing Lens next-turn context.",
		parameters: contextSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["context", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()];
			pushBool(args, "--ack", params.ack);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens context", args.ack ? "ack" : "show"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_raw_output",
		label: "Lens raw output",
		description: "List or show retained sanitized Lens raw output via ct lens raw-output.",
		parameters: rawOutputSchema,
		executionMode: "parallel",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "list";
			const args = ["raw-output", action];
			if (action === "show") args.push(String(required(params.id, "id")));
			else pushOpt(args, "--limit", params.limit);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens raw output", args.action ?? "list"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_prune",
		label: "Lens prune",
		description: "Prune Lens telemetry using retention policy via ct lens prune.",
		parameters: pruneSchema,
		executionMode: "exclusive",
		renderShell: "self",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["prune"];
			pushBool(args, "--dry-run", params.dryRun);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens prune", args.dryRun ? "dry run" : "retention"));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

}

function sessionIdFromFile(ctx: any): string | undefined {
	const file = ctx?.sessionManager?.getSessionFile?.();
	return typeof file === "string" && file ? basename(file).replace(/\.jsonl$/, "") : undefined;
}

function required<T>(value: T | undefined | null, name: string): T {
	if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
	return value;
}

function filesFromTool(toolName: string, input: any): ToolFile[] {
	const files: ToolFile[] = [];
	const path = typeof input?.path === "string" ? input.path : undefined;
	if (path) {
		if (toolName === "read") files.push(file(path, "read", input.offset, input.offset && input.limit ? input.offset + input.limit - 1 : undefined));
		else if (toolName === "write") files.push(file(path, "write"));
		else if (toolName === "edit") files.push(file(path, "edit"));
	}
	for (const key of ["paths", "files"]) {
		if (!Array.isArray(input?.[key])) continue;
		for (const item of input[key]) if (typeof item === "string") files.push(file(item, readLikeOperation(toolName)));
	}
	return files;
}

function file(path: string, operation: string, startLine?: unknown, endLine?: unknown): ToolFile {
	const out: ToolFile = { path, operation };
	if (typeof startLine === "number" && Number.isFinite(startLine)) out.start_line = Math.max(1, Math.trunc(startLine));
	if (typeof endLine === "number" && Number.isFinite(endLine)) out.end_line = Math.max(out.start_line ?? 1, Math.trunc(endLine));
	return out;
}

function readLikeOperation(toolName: string): string {
	return toolName === "write" || toolName === "edit" ? "edit" : "read";
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
		.join("\n");
}
