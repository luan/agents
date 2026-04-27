import { basename } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatCommand, runCommand } from "../shared/ct-runner.ts";
import { nf, renderText, title } from "../shared/ct-render.ts";
import { lensSeverity, renderLensCompactStatus, renderLensWidgetLines, summarizeLensResult } from "../shared/lens-ui.ts";

const HOOK_EVENT_SCHEMA = "lens.hook_event.v1";
const RAW_OUTPUT_MAX_BYTES = 256 * 1024;
const BLOCKING_GUARD_ENABLED = false;

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

const discoverSchema = Type.Object({
	intent: StringEnum(["symbol", "text", "path", "source-context", "ast", "lsp"] as const),
	query: Type.Optional(Type.String({ description: "Symbol, text, AST, or LSP query." })),
	path: Type.Optional(Type.String({ description: "Optional file/path filter." })),
	line: Type.Optional(Type.Number({ description: "1-based source line." })),
	endLine: Type.Optional(Type.Number({ description: "1-based ending source line." })),
	character: Type.Optional(Type.Number({ description: "1-based source character for LSP requests." })),
	lang: Type.Optional(Type.String({ description: "Language hint." })),
	limit: Type.Optional(Type.Number({ description: "Maximum normalized results." })),
	context: Type.Optional(Type.Number({ description: "Context lines when source is shown." })),
	lspOperation: Type.Optional(Type.String({ description: "LSP operation, e.g. hover or definition." })),
	detail: Type.Optional(Type.Boolean({ description: "Include resolver/debug fields." })),
	raw: Type.Optional(Type.Boolean({ description: "Include raw backend fields." })),
	session: sessionTurnSchema.session,
});

const guardSchema = Type.Object({
	action: Type.Optional(StringEnum(["check", "record_read", "allow_once"] as const)),
	path: Type.String({ description: "Path to check, record, or allow once." }),
	startLine: Type.Optional(Type.Number({ description: "Start line for check/record_read." })),
	endLine: Type.Optional(Type.Number({ description: "End line for check/record_read." })),
	session: sessionTurnSchema.session,
	mode: Type.Optional(StringEnum(["off", "warn", "block"] as const)),
});

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

const healthSchema = Type.Object({
	operation: Type.Optional(StringEnum(["turn", "status"] as const)),
	session: sessionTurnSchema.session,
	turn: sessionTurnSchema.turn,
	finalOutput: Type.Optional(Type.Boolean({ description: "Request final/agent-end style text for CLI parity." })),
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

function pushOpt(args: string[], flag: string, value: unknown) {
	if (value !== undefined && value !== null && value !== false) args.push(flag, String(value));
}

function pushBool(args: string[], flag: string, value: unknown) {
	if (value === true) args.push(flag);
}

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

export default function lensExtension(pi: ExtensionAPI) {
	const registerTool = pi.registerTool.bind(pi) as any;
	let sessionSeq = 0;
	let agentSeq = 0;
	let activeTurnIndex = 0;
	let activeTurnId = "turn-0-0";

	const currentSession = (ctx: any) => ctx?.sessionManager?.getSessionId?.() ?? sessionIdFromFile(ctx) ?? "ephemeral";
	const currentTurn = () => activeTurnId;

	async function runHook(name: string, event: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
		const result = await runCommand("ct", ["hook", name], cwd, {
			signal,
			input: JSON.stringify(event),
			allowNonZero: true,
		});
		try {
			return JSON.parse(result.stdout);
		} catch (error) {
			return {
				schema_version: "lens.hook_response.v1",
				status: "degraded",
				decision: { outcome: "allow", reason: "invalid_hook_response", guard: [] },
				health: { status: "degraded", compact: "degraded · hook failed" },
				warnings: [],
				errors: [{ code: "invalid_hook_response", message: hookFailureMessage(error, result) }],
				data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
			};
		}
	}

	function hookFailureMessage(error: unknown, result: { stderr?: string; exitCode?: number }) {
		const stderr = result.stderr?.trim();
		const suffix = stderr ? `: ${stderr}` : `: ${String(error)}`;
		return `ct hook failed${typeof result.exitCode === "number" ? ` with exit code ${result.exitCode}` : ""}${suffix}`;
	}

	function eventFor(ctx: any, event: LensHookEventName, extra: Record<string, unknown> = {}) {
		return {
			schema_version: HOOK_EVENT_SCHEMA,
			host: { name: "pi", kind: "extension" },
			session: { id: currentSession(ctx), seq: sessionSeq },
			cwd: ctx.cwd,
			turn: { id: currentTurn(), index: activeTurnIndex },
			event,
			known_files: [],
			policy: { guard_mode: "warn", allow_overrides: false },
			...extra,
		};
	}

	function applyLensUi(ctx: any, response: unknown) {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("lens", renderLensCompactStatus(response, { ansi: true }));
		ctx.ui.setWidget("lens-health", lensSeverity(response) === "clean" ? [] : renderLensWidgetLines(response, false, { ansi: true }));
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionSeq++;
		agentSeq = 0;
		activeTurnIndex = 0;
		activeTurnId = "turn-0-0";
		const response = await runHook("lens-session-start", eventFor(ctx, "session_start"), ctx.cwd);
		applyLensUi(ctx, response);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		agentSeq++;
		activeTurnIndex = 0;
		activeTurnId = `turn-${agentSeq}-0`;
		const response = await runHook("lens-context", eventFor(ctx, "context_injection"), ctx.cwd, ctx.signal);
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

	pi.on("turn_start", async (event, ctx) => {
		activeTurnIndex = Number.isFinite(event.turnIndex) ? event.turnIndex : activeTurnIndex;
		activeTurnId = `turn-${agentSeq}-${activeTurnIndex}`;
		const response = await runHook("lens-turn-start", eventFor(ctx, "turn_start"), ctx.cwd, ctx.signal);
		applyLensUi(ctx, response);
	});

	pi.on("tool_call", async (event, ctx) => {
		const response = await runHook(
			"lens-pre-tool",
			eventFor(ctx, "pre_tool", {
				tool: { name: event.toolName, id: event.toolCallId, status: "started", input: event.input },
				known_files: filesFromTool(event.toolName, event.input),
			}),
			ctx.cwd,
			ctx.signal,
		);
		applyLensUi(ctx, response);
		if (isExplicitGuardBlock(response)) {
			return { block: true, reason: renderLensCompactStatus(response) };
		}
	});

	function isExplicitGuardBlock(response: any) {
		if (!BLOCKING_GUARD_ENABLED) return false;
		if (String(response?.decision?.outcome ?? "").toLowerCase() !== "block") return false;
		return String(response?.decision?.reason ?? "") !== "invalid_hook_response";
	}

	pi.on("tool_result", async (event, ctx) => {
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
			ctx.cwd,
			ctx.signal,
		);
		applyLensUi(ctx, response);
	});

	pi.on("turn_end", async (event, ctx) => {
		activeTurnIndex = Number.isFinite(event.turnIndex) ? event.turnIndex : activeTurnIndex;
		activeTurnId = `turn-${agentSeq}-${activeTurnIndex}`;
		const response = await runHook("lens-turn-end", eventFor(ctx, "turn_end"), ctx.cwd, ctx.signal);
		applyLensUi(ctx, response);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const response = await runHook("lens-agent-end", eventFor(ctx, "agent_end"), ctx.cwd, ctx.signal);
		applyLensUi(ctx, response);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const response = await runHook("lens-session-shutdown", eventFor(ctx, "session_shutdown"), ctx.cwd);
		applyLensUi(ctx, response);
	});

	registerTool({
		name: "lens_discover",
		label: "Lens discover",
		description: "Discover Lens code context through ct lens discover. Full JSON is preserved in tool details.",
		parameters: discoverSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["discover", "--intent", params.intent];
			pushOpt(args, "--query", params.query);
			pushOpt(args, "--path", params.path);
			pushOpt(args, "--line", params.line);
			pushOpt(args, "--end-line", params.endLine);
			pushOpt(args, "--character", params.character);
			pushOpt(args, "--lang", params.lang);
			pushOpt(args, "--limit", params.limit);
			pushOpt(args, "--context", params.context);
			pushOpt(args, "--session", params.session ?? currentSession(ctx));
			pushOpt(args, "--lsp-operation", params.lspOperation);
			pushBool(args, "--debug", params.detail);
			pushBool(args, "--raw", params.raw);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens discover", `${args.intent}${args.query ? ` · ${args.query}` : ""}`));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_guard",
		label: "Lens guard",
		description: "Check or update Lens read-before-edit guard via ct lens guard/read. Actions: check, record_read, allow_once.",
		parameters: guardSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "check";
			if (action === "record_read") {
				const args = ["read", "record", "--path", params.path, "--start-line", String(required(params.startLine, "startLine")), "--end-line", String(required(params.endLine, "endLine"))];
				pushOpt(args, "--session", params.session ?? currentSession(ctx));
				return runCtLens(args, ctx.cwd, signal);
			}
			if (action === "allow_once") {
				const args = ["guard", "allow-once", "--path", params.path];
				pushOpt(args, "--session", params.session ?? currentSession(ctx));
				return runCtLens(args, ctx.cwd, signal);
			}
			const args = ["guard", "check", "--path", params.path, "--start-line", String(required(params.startLine, "startLine")), "--end-line", String(required(params.endLine, "endLine"))];
			pushOpt(args, "--session", params.session ?? currentSession(ctx));
			pushOpt(args, "--mode", params.mode);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.guard, "lens guard", `${args.action ?? "check"} · ${args.path}`));
		},
		renderResult(result, options, _theme, ctx) {
			return renderText(ctx, summarizeLensResult(result, options.expanded, { ansi: true }));
		},
	});

	registerTool({
		name: "lens_diagnostics",
		label: "Lens diagnostics",
		description: "List, record, or snapshot Lens diagnostics via ct lens diagnostics. Full JSON is preserved in details.",
		parameters: diagnosticsSchema,
		executionMode: "parallel",
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
		name: "lens_health",
		label: "Lens health",
		description: "Show Lens turn health, or repository status when operation=status/no turn is provided.",
		parameters: healthSchema,
		executionMode: "parallel",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.operation === "status" || (!params.session && !params.turn)) return runCtLens(["status"], ctx.cwd, signal);
			const args = ["health", "--session", params.session ?? currentSession(ctx), "--turn", params.turn ?? currentTurn()];
			pushBool(args, "--final-output", params.finalOutput);
			return runCtLens(args, ctx.cwd, signal);
		},
		renderCall(args, theme, ctx) {
			return renderText(ctx, title(theme, nf.lens, "lens health", args.operation ?? "turn"));
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
		description: "Show a deeper Lens changed-file report with diagnostics, guard, cleanup, patch refs, and symbols.",
		parameters: reportSchema,
		executionMode: "parallel",
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
		else if (toolName === "lens_discover") files.push(file(path, "discover", input.line, input.endLine));
		else if (toolName === "lens_guard" && input?.action === "record_read") files.push(file(path, "read", input.startLine, input.endLine));
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
