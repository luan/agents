import { basename } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import { runCommand } from "../shared/ct-runner.ts";
import { renderLensCompactStatus, renderLensWidgetLines } from "../shared/lens-ui.ts";

const HOOK_EVENT_SCHEMA = "lens.hook_event.v1";
const RAW_OUTPUT_MAX_BYTES = 256 * 1024;
type LensHookEventName =
	| "session_start"
	| "context_injection"
	| "pre_tool"
	| "post_tool"
	| "turn_start"
	| "turn_end"
	| "agent_end"
	| "session_shutdown";

type ToolFile = {
	path: string;
	operation: string;
	start_line?: number;
	end_line?: number;
	generated?: boolean;
	include_ignored?: boolean;
};

type CommandRunner = typeof runCommand;
type ThemeLike = { fg(color: "muted", text: string): string };

type QueuedLensIssue = {
	source?: string;
	path?: string;
	line?: number;
	message?: string;
	code?: string;
	fingerprint?: string;
};

class LensWidget implements Component {
	private lines: string[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly tui: TUI) {}

	setLines(lines: string[]) {
		this.lines = lines;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.lines.map((line) => truncateToWidth(line, width));
		return this.cachedLines;
	}

	invalidate() {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

let lensWidget: LensWidget | undefined;
let lensWidgetRegistered = false;

function isStaleCtxError(error: unknown) {
	return (error instanceof Error ? error.message : String(error)).includes("ctx is stale");
}

function ensureLensWidget(ctx: any) {
	if (lensWidgetRegistered) return;
	lensWidgetRegistered = true;
	ctx.ui.setWidget("lens-health", (tui: TUI, _theme: ThemeLike) => {
		lensWidget = new LensWidget(tui);
		return lensWidget;
	});
}

export function applyLensUi(ctx: any, response: unknown) {
	try {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("lens", renderLensCompactStatus(response, { ansi: true }));
		ensureLensWidget(ctx);
		lensWidget?.setLines(renderLensWidgetLines(response, false, { ansi: true }));
	} catch (error) {
		if (!isStaleCtxError(error)) throw error;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function reportIssuesFromResponse(response: any): QueuedLensIssue[] {
	const issues = Array.isArray(response?.data?.report?.issues) ? response.data.report.issues : [];
	return issues.map(reportIssue).filter((issue): issue is QueuedLensIssue => issue !== undefined);
}

function reportIssue(issue: any): QueuedLensIssue | undefined {
	const out: QueuedLensIssue = {
		source: stringValue(issue?.source),
		path: stringValue(issue?.path),
		message: stringValue(issue?.message),
		code: stringValue(issue?.code),
		fingerprint: stringValue(issue?.fingerprint),
	};
	if (typeof issue?.line === "number") out.line = issue.line;
	return Object.values(out).some((value) => value !== undefined) ? out : undefined;
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

export async function hasActiveLensDiagnostics(
	cwd: string,
	options: { signal?: AbortSignal; runner?: CommandRunner } = {},
): Promise<boolean | undefined> {
	const diagnostics = await listActiveLensDiagnostics(cwd, options);
	return Array.isArray(diagnostics) ? diagnostics.length > 0 : undefined;
}

export async function listActiveLensDiagnostics(
	cwd: string,
	options: { signal?: AbortSignal; runner?: CommandRunner } = {},
): Promise<any[] | undefined> {
	try {
		const result = await (options.runner ?? runCommand)(
			"ct",
			["lens", "diagnostics", "list", "--json", "--all"],
			cwd,
			{
				signal: options.signal,
				allowNonZero: true,
			},
		);
		const parsed = JSON.parse(result.stdout);
		return Array.isArray(parsed?.data?.diagnostics) ? parsed.data.diagnostics : undefined;
	} catch {
		return undefined;
	}
}

export async function suppressStaleLensDiagnosticMessage(
	message: any,
	cwd: string,
	options: { signal?: AbortSignal; runner?: CommandRunner } = {},
) {
	if (message?.role !== "custom" || message.customType !== "lens-diagnostics") return undefined;
	const active = await listActiveLensDiagnostics(cwd, options);
	if (!active || reportStillMatchesActiveDiagnostics(message, active)) return undefined;
	return {
		message: {
			...message,
			content: [],
			display: false,
			details: {
				...(message.details ?? {}),
				requiresFollowup: false,
				reportIssues: [],
				suppressedAsStale: true,
			},
		},
	};
}

export function suppressInactiveDiagnosticInjection(response: any, active: any[] | boolean | undefined) {
	if (response?.context?.inject !== true) return response;
	if (active === true) return response;
	if (Array.isArray(active) && reportStillMatchesActiveDiagnostics(diagnosticMessageFromResponse(response), active)) {
		return response;
	}
	return {
		...response,
		status: "ok",
		context: { ...response.context, inject: false, content: "" },
	};
}

function diagnosticMessageFromResponse(response: any) {
	return {
		content: [{ type: "text", text: typeof response?.context?.content === "string" ? response.context.content : "" }],
		details: {
			reportIssues: reportIssuesFromResponse(response),
		},
	};
}

function reportStillMatchesActiveDiagnostics(message: any, active: any[]) {
	if (active.length === 0) return false;
	const structuredIssues = Array.isArray(message?.details?.reportIssues)
		? message.details.reportIssues
				.map(reportIssue)
				.filter((issue: QueuedLensIssue | undefined) => issue !== undefined)
		: [];
	if (structuredIssues.length > 0) {
		return structuredIssues.some((issue: QueuedLensIssue) =>
			active.some((diagnostic) => diagnosticMatchesQueuedIssue(diagnostic, issue)),
		);
	}
	const report = messageText(message);
	const reportIssues = report
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "));
	if (reportIssues.length === 0) return false;
	return reportIssues.some((line) => active.some((diagnostic) => diagnosticMatchesReportLine(diagnostic, line)));
}

function diagnosticMatchesReportLine(diagnostic: any, line: string) {
	const path = typeof diagnostic?.rel_path === "string" ? diagnostic.rel_path : undefined;
	if (!path || !line.includes(path)) return false;
	const message = typeof diagnostic?.message === "string" ? diagnostic.message : undefined;
	const code = typeof diagnostic?.code === "string" ? diagnostic.code : undefined;
	return (message && line.includes(message)) || (code && line.includes(`[${code}]`));
}

function diagnosticMatchesQueuedIssue(diagnostic: any, issue: QueuedLensIssue) {
	if (issue.fingerprint) return diagnostic?.fingerprint === issue.fingerprint;
	if (issue.path && diagnostic?.rel_path !== issue.path) return false;
	if (issue.code && diagnostic?.code !== issue.code) return false;
	if (issue.message && diagnostic?.message !== issue.message) return false;
	if (typeof issue.line === "number" && diagnostic?.start_line !== issue.line) return false;
	if (issue.source && diagnosticSourceName(diagnostic?.source) !== issue.source) return false;
	return true;
}

function diagnosticSourceName(source: unknown) {
	if (typeof source === "string") return source;
	if (source && typeof source === "object") {
		const entries = Object.entries(source);
		if (entries.length === 1) {
			const [key, value] = entries[0]!;
			return typeof value === "string" ? `${key}:${value}` : key;
		}
	}
	return undefined;
}

function messageText(message: any) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : "")).join("");
	}
	return "";
}

type CtHookCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

function hookFailureResponse(code: string, message: string, result?: CtHookCommandResult) {
	return {
		schema_version: "lens.hook_response.v1",
		status: "error",
		decision: { outcome: "allow", reason: code },
		data: {
			status: "errors",
			sources: [{ name: "lens", connected: false, errors: 1, warnings: 0 }],
			...(result
				? {
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					}
				: {}),
		},
		warnings: [],
		errors: [{ code, message }],
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
	let sessionSeq = 0;
	let agentSeq = 0;
	let activeTurnIndex = 0;
	let activeTurnId = "turn-0-0";

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
			const response = await runHook(
				"lens-context",
				eventFor(ctx, "context_injection"),
				safeCwd(ctx),
				safeSignal(ctx),
			);
			applyLensUi(ctx, response);
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
					tool: {
						name: event.toolName,
						id: event.toolCallId,
						status: "started",
						input: event.input,
					},
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
					known_files: filesFromToolAndResult(event.toolName, event.input, event.details),
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
			let response = await runHook("lens-turn-end", eventFor(ctx, "turn_end"), safeCwd(ctx), safeSignal(ctx));
			if (response?.context?.inject === true) {
				const active = await listActiveLensDiagnostics(safeCwd(ctx), { signal: safeSignal(ctx) });
				response = suppressInactiveDiagnosticInjection(response, active);
			}
			applyLensUi(ctx, response);
		});
	});

	pi.on("message_end", async (event, ctx) => {
		return ignoreStaleCtx(async () => {
			return suppressStaleLensDiagnosticMessage(event.message, safeCwd(ctx), { signal: safeSignal(ctx) });
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await ignoreStaleCtx(async () => {
			const response = await runHook("lens-agent-end", eventFor(ctx, "agent_end"), safeCwd(ctx), safeSignal(ctx));
			applyLensUi(ctx, response);
		});
	});

	pi.on("session_shutdown", async () => {
		lensWidget = undefined;
		lensWidgetRegistered = false;
	});
}

function sessionIdFromFile(ctx: any): string | undefined {
	const file = ctx?.sessionManager?.getSessionFile?.();
	return typeof file === "string" && file ? basename(file).replace(/\.jsonl$/, "") : undefined;
}

export function filesFromTool(toolName: string, input: any): ToolFile[] {
	if (isApplyPatchTool(toolName)) {
		return filesFromApplyPatchInput(input);
	}

	const files: ToolFile[] = [];
	const path = typeof input?.path === "string" ? input.path : undefined;
	if (path) {
		if (toolName === "read")
			files.push(
				file(path, "read", input.offset, input.offset && input.limit ? input.offset + input.limit - 1 : undefined),
			);
		else if (toolName === "write") files.push(file(path, "write"));
		else if (toolName === "edit") files.push(file(path, "edit"));
	}
	for (const key of ["paths", "files"]) {
		if (!Array.isArray(input?.[key])) continue;
		for (const item of input[key]) if (typeof item === "string") files.push(file(item, readLikeOperation(toolName)));
	}
	return files;
}

export function filesFromToolAndResult(toolName: string, input: any, details: any): ToolFile[] {
	return dedupeFiles([...filesFromTool(toolName, input), ...filesFromToolResult(toolName, details)]);
}

function filesFromToolResult(toolName: string, details: any): ToolFile[] {
	if (!isApplyPatchTool(toolName)) return [];
	const diffs = Array.isArray(details?.fileDiffs)
		? details.fileDiffs
		: Array.isArray(details?.files)
			? details.files
			: [];
	const files: ToolFile[] = [];
	for (const diff of diffs) {
		const path = typeof diff?.path === "string" ? diff.path : undefined;
		if (!path) continue;
		const operation = applyPatchOperation(diff?.operation);
		const moveTo = typeof diff?.moveTo === "string" ? diff.moveTo : undefined;
		if (moveTo) {
			files.push(file(path, "delete"));
			files.push(file(moveTo, "write"));
		} else {
			files.push(file(path, operation));
		}
	}
	return files;
}

function isApplyPatchTool(toolName: string): boolean {
	return toolName === "apply_patch" || toolName.endsWith(".apply_patch");
}

function applyPatchOperation(operation: unknown): string {
	switch (operation) {
		case "add":
			return "write";
		case "delete":
			return "delete";
		default:
			return "edit";
	}
}

function filesFromApplyPatchInput(input: any): ToolFile[] {
	const text =
		typeof input === "string"
			? input
			: typeof input?.input === "string"
				? input.input
				: typeof input?.patch === "string"
					? input.patch
					: "";
	if (!text) return [];

	const files: ToolFile[] = [];
	const moveFromUpdate = new Map<number, string>();
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const add = line.match(/^\*\*\* Add File: (.+)$/);
		if (add) {
			files.push(file(add[1]!.trim(), "write"));
			continue;
		}
		const update = line.match(/^\*\*\* (?:Update File|Update Scope|Replace All In File): (.+)$/);
		if (update) {
			files.push(file(update[1]!.trim(), "edit"));
			continue;
		}
		const remove = line.match(/^\*\*\* Delete File: (.+)$/);
		if (remove) {
			files.push(file(remove[1]!.trim(), "delete"));
			continue;
		}
		const move = line.match(/^\*\*\* Move File: (.+) -> (.+)$/);
		if (move) {
			files.push(file(move[1]!.trim(), "delete"));
			files.push(file(move[2]!.trim(), "write"));
			continue;
		}
		const moveTo = line.match(/^\*\*\* Move to: (.+)$/);
		if (moveTo) {
			const previousIndex = lastIndexOfOperation(files);
			if (previousIndex !== undefined) {
				moveFromUpdate.set(previousIndex, moveTo[1]!.trim());
			}
		}
	}

	for (const [index, target] of moveFromUpdate) {
		const original = files[index];
		if (!original) continue;
		original.operation = "delete";
		files.push(file(target, "write"));
	}

	return dedupeFiles(files);
}

function lastIndexOfOperation(files: ToolFile[]): number | undefined {
	for (let index = files.length - 1; index >= 0; index--) {
		if (files[index]?.operation === "edit") return index;
	}
	return undefined;
}

function dedupeFiles(files: ToolFile[]): ToolFile[] {
	const byKey = new Map<string, ToolFile>();
	for (const item of files) {
		const key = `${item.path}\0${item.operation}`;
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()];
}

function file(path: string, operation: string, startLine?: unknown, endLine?: unknown): ToolFile {
	const out: ToolFile = { path, operation };
	if (typeof startLine === "number" && Number.isFinite(startLine)) out.start_line = Math.max(1, Math.trunc(startLine));
	if (typeof endLine === "number" && Number.isFinite(endLine))
		out.end_line = Math.max(out.start_line ?? 1, Math.trunc(endLine));
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
