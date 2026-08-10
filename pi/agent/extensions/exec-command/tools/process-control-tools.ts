import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	runningCellElapsedMs,
	sharedAnimationRenderAllowed,
	shineText,
	shouldAnimateRunningCell,
} from "../../shared/tui";
import { darkerCardBackgroundAnsi, framedBlock, renderStatusLine, textComponent } from "../../shared/tui/card";
import { formatElapsedTime } from "./exec-cell-rendering-internal.ts";
import type { ExecSessionManager, ExecSessionRecord } from "./exec-session-manager.ts";

const PROCESS_SELECTOR_FIELDS = {
	process: Type.Optional(
		Type.Union([Type.Number(), Type.String()], {
			description: "Managed process ID or stable name.",
		}),
	),
	process_id: Type.Optional(Type.Number({ description: "Managed process ID. Prefer process." })),
};

function selector(params: unknown): number | string {
	if (!params || typeof params !== "object") throw new Error("A process ID or name is required");
	const record = params as Record<string, unknown>;
	if (typeof record.process === "number" || typeof record.process === "string") return record.process;
	if (typeof record.process_id === "number") return record.process_id;
	throw new Error("A process ID or name is required");
}

function summary(record: ExecSessionRecord) {
	return {
		process_id: record.id,
		process_name: record.name,
		command: record.command,
		cwd: record.cwd,
		state: record.state,
		exit_code: record.exitCode,
		stdin_open: record.stdinOpen,
		started_at_ms: record.startedAtMs,
		finished_at_ms: record.finishedAtMs,
	};
}

function processState(details: Record<string, unknown>): string {
	if (details.state === "running") return "running";
	return details.exit_code === undefined ? String(details.state ?? "exited") : `exited ${details.exit_code}`;
}

function processElapsedMs(details: Record<string, unknown>): number | undefined {
	if (typeof details.started_at_ms !== "number") return undefined;
	const finishedAt = typeof details.finished_at_ms === "number" ? details.finished_at_ms : Date.now();
	return Math.max(0, finishedAt - details.started_at_ms);
}

function formatProcessDetails(details: Record<string, unknown>): string {
	const elapsedMs = processElapsedMs(details);
	return [
		`Process: #${details.process_id} ${details.process_name ?? ""}`.trimEnd(),
		`State: ${processState(details)}`,
		`Command: ${details.command ?? ""}`,
		`Working directory: ${details.cwd ?? ""}`,
		`Standard input: ${details.stdin_open ? "open" : "closed"}`,
		...(elapsedMs === undefined ? [] : [`Elapsed: ${formatElapsedTime(elapsedMs)}`]),
	].join("\n");
}
function processRenderers(title: string, showDetails = false) {
	return {
		renderShell: "self" as const,
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: { fg(color: string, text: string): string; bold(text: string): string },
			context: { isPartial?: boolean },
		) {
			if (context.isPartial !== true) return textComponent("");
			const input = args ?? {};
			const process =
				typeof input.process === "string" || typeof input.process === "number"
					? String(input.process)
					: typeof input.process_id === "number"
						? String(input.process_id)
						: undefined;
			return framedBlock(theme, {
				header: renderStatusLine(theme, { icon: "pending", title, description: process }),
				borderColor: "accent",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		renderResult(
			result: {
				content?: Array<{ type: string; text?: string }>;
				details?: Record<string, unknown>;
			},
			_options: unknown,
			theme: { fg(color: string, text: string): string; bold(text: string): string },
			context: { isError?: boolean },
		) {
			const processes = Array.isArray(result.details?.processes) ? result.details.processes : undefined;
			const details = showDetails ? result.details : undefined;
			const lines = processes
				? processes.map((value) => {
						const process = value as Record<string, unknown>;
						const state = processState(process);
						return `${theme.fg(state === "running" ? "accent" : "muted", state)} ${theme.fg("dim", `#${process.process_id}`)} ${String(process.command ?? "")}`;
					})
				: details
					? [
							`${theme.fg("muted", "Command")}  ${details.command ?? ""}`,
							`${theme.fg("muted", "Directory")} ${details.cwd ?? ""}`,
							`${theme.fg("muted", "Input")}    ${details.stdin_open ? "open" : "closed"}`,
						]
					: (result.content
							?.filter((part) => part.type === "text" && typeof part.text === "string")
							.flatMap((part) => part.text!.split(/\r?\n/))
							.slice(0, 8) ?? []);
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					icon: context.isError ? "error" : "success",
					title,
					description: details ? `#${details.process_id} ${details.process_name ?? ""}`.trimEnd() : undefined,
					meta: processes
						? [`${processes.length} process${processes.length === 1 ? "" : "es"}`]
						: details
							? [
									processState(details),
									...(processElapsedMs(details) === undefined
										? []
										: [formatElapsedTime(processElapsedMs(details) as number)]),
								]
							: undefined,
				}),
				sections: [{ lines: lines.length ? lines : [theme.fg("muted", "No managed processes.")] }],
				borderColor: context.isError ? "error" : "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, context.isError ? "toolErrorBg" : "toolPendingBg"),
			});
		},
	};
}

const PROCESS_WAIT_FRAME_MS = 120;

interface ProcessWaitRenderContext {
	isPartial?: boolean;
	isError?: boolean;
	invalidate?: () => void;
	state?: {
		elapsedTimer?: ReturnType<typeof setTimeout>;
		startedAtMs?: number;
	};
}

function scheduleWaitAnimation(context: ProcessWaitRenderContext, running: boolean): void {
	const state = context.state;
	if (!state) return;
	if (!shouldAnimateRunningCell(state, running)) {
		if (state.elapsedTimer) clearTimeout(state.elapsedTimer);
		state.elapsedTimer = undefined;
		return;
	}
	if (state.elapsedTimer || !context.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		if (sharedAnimationRenderAllowed()) context.invalidate?.();
	}, PROCESS_WAIT_FRAME_MS);
	state.elapsedTimer.unref?.();
}

function waitRenderers() {
	return {
		renderShell: "self" as const,
		renderCall(
			args: Record<string, unknown> | undefined,
			theme: { fg(color: string, text: string): string; bold(text: string): string },
			context: ProcessWaitRenderContext,
		) {
			const running = context.isPartial === true;
			const elapsedMs = runningCellElapsedMs(context.state, running);
			scheduleWaitAnimation(context, running);
			if (!running) return textComponent("");
			const input = args ?? {};
			const process =
				typeof input.process === "string" || typeof input.process === "number"
					? String(input.process)
					: typeof input.process_id === "number"
						? String(input.process_id)
						: "";
			const label = `Waiting for process${process ? ` ${process}` : ""}`;
			return textComponent(
				`${shineText(theme, label, elapsedMs, { fallback: (text) => theme.fg("accent", text) })} ${theme.fg("dim", `· ${formatElapsedTime(elapsedMs ?? 0)}`)}`,
			);
		},
		renderResult(
			result: { details?: Record<string, unknown> },
			_options: unknown,
			theme: { fg(color: string, text: string): string; bold(text: string): string },
			context: ProcessWaitRenderContext,
		) {
			scheduleWaitAnimation(context, false);
			const details = result.details ?? {};
			const process = details.process as Record<string, unknown> | undefined;
			const meta = [
				typeof details.outcome === "string" ? details.outcome : undefined,
				typeof details.wait_elapsed_ms === "number" ? formatElapsedTime(details.wait_elapsed_ms) : undefined,
			].filter((value): value is string => value !== undefined);
			return textComponent(
				renderStatusLine(theme, {
					icon: context.isError ? "error" : "success",
					title: "Wait for process",
					description: typeof process?.process_name === "string" ? process.process_name : undefined,
					meta,
				}),
			);
		},
	};
}

export function registerProcessControlTools(pi: ExtensionAPI, sessions: ExecSessionManager): void {
	pi.registerTool({
		name: "process_list",
		label: "process_list",
		description: "Lists visible managed exec processes without returning their output.",
		promptSnippet: "List managed exec processes.",
		parameters: Type.Object({}),
		...processRenderers("Processes"),
		async execute() {
			const processes = sessions.listSessions().map(summary);
			return {
				content: [
					{ type: "text", text: processes.length ? JSON.stringify(processes, null, 2) : "No managed processes." },
				],
				details: { processes },
			};
		},
	});

	pi.registerTool({
		name: "process_describe",
		label: "process_describe",
		description: "Returns metadata for one managed exec process without its output.",
		promptSnippet: "Inspect one managed exec process.",
		parameters: Type.Object(PROCESS_SELECTOR_FIELDS),
		...processRenderers("Process details", true),
		async execute(_toolCallId, params) {
			const process = selector(params);
			const record = sessions.describe(process);
			if (!record) throw new Error(`Unknown process ${process}`);
			const details = summary(record);
			return { content: [{ type: "text", text: formatProcessDetails(details) }], details };
		},
	});

	pi.registerTool({
		name: "process_wait",
		label: "process_wait",
		description: "Waits for a managed exec process to exit or emit a text pattern.",
		promptSnippet: "Wait for process exit or output.",
		parameters: Type.Object({
			...PROCESS_SELECTOR_FIELDS,
			pattern: Type.Optional(Type.String({ description: "Text to wait for. Omit to wait for process exit." })),
			timeout_ms: Type.Optional(Type.Number({ minimum: 1, description: "Maximum wait. Defaults to 10 seconds." })),
		}),
		...waitRenderers(),
		async execute(_toolCallId, params) {
			const typed = params as { pattern?: string; timeout_ms?: number };
			const process = selector(params);
			const startedAtMs = Date.now();
			const result = await sessions.wait(process, typed.pattern, typed.timeout_ms);
			if (!result) throw new Error(`Unknown process ${process}`);
			const details = summary(result.process);
			const outcome = result.timed_out
				? "timed out"
				: result.matched
					? "matched"
					: typed.pattern
						? "exited before pattern"
						: "exited";
			const waitElapsedMs = Date.now() - startedAtMs;
			return {
				content: [
					{
						type: "text",
						text: `Process ${result.process.name} wait ${outcome} after ${formatElapsedTime(waitElapsedMs)}.`,
					},
				],
				details: { ...result, process: details, outcome, wait_elapsed_ms: waitElapsedMs },
			};
		},
	});

	pi.registerTool({
		name: "process_resize",
		label: "process_resize",
		description: "Resizes the PTY for one running managed exec process.",
		promptSnippet: "Resize a managed terminal process.",
		parameters: Type.Object({
			...PROCESS_SELECTOR_FIELDS,
			cols: Type.Number({ minimum: 1 }),
			rows: Type.Number({ minimum: 1 }),
		}),
		...processRenderers("Resize process"),
		async execute(_toolCallId, params) {
			const typed = params as { cols: number; rows: number };
			const process = selector(params);
			if (!(await sessions.resize(process, typed.cols, typed.rows))) {
				throw new Error(`Process ${process} is unknown, exited, or has no PTY`);
			}
			return {
				content: [{ type: "text", text: `Resized process ${process} to ${typed.cols}x${typed.rows}.` }],
				details: { process, cols: typed.cols, rows: typed.rows },
			};
		},
	});

	pi.registerTool({
		name: "process_signal",
		label: "process_signal",
		description: "Sends INT, TERM, or KILL to one running managed exec process.",
		promptSnippet: "Signal a managed exec process.",
		parameters: Type.Object({
			...PROCESS_SELECTOR_FIELDS,
			signal: Type.Union([Type.Literal("INT"), Type.Literal("TERM"), Type.Literal("KILL")]),
		}),
		...processRenderers("Signal process"),
		async execute(_toolCallId, params) {
			const typed = params as { signal: "INT" | "TERM" | "KILL" };
			const process = selector(params);
			if (!(await sessions.signal(process, typed.signal))) throw new Error(`Unknown or exited process ${process}`);
			return {
				content: [{ type: "text", text: `Sent ${typed.signal} to process ${process}.` }],
				details: { process, signal: typed.signal, sent: true },
			};
		},
	});

	pi.registerTool({
		name: "process_restart",
		label: "process_restart",
		description: "Restarts one managed exec process with its original command, cwd, environment, and stable name.",
		promptSnippet: "Restart a managed exec process.",
		parameters: Type.Object(PROCESS_SELECTOR_FIELDS),
		...processRenderers("Restart process"),
		async execute(_toolCallId, params) {
			const process = selector(params);
			const result = await sessions.restart(process);
			if (!result) throw new Error(`Unknown process ${process}`);
			return {
				content: [{ type: "text", text: `Restarted process ${process} as process ${result.process_id}.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "process_stop",
		label: "process_stop",
		description: "Stops one managed exec process.",
		promptSnippet: "Stop a managed exec process.",
		parameters: Type.Object(PROCESS_SELECTOR_FIELDS),
		...processRenderers("Stop process"),
		async execute(_toolCallId, params) {
			const process = selector(params);
			if (!sessions.stopSession(process)) throw new Error(`Unknown process ${process}`);
			return {
				content: [{ type: "text", text: `Stopped process ${process}.` }],
				details: { process, stopped: true },
			};
		},
	});
}
