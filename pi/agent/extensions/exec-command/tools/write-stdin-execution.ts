import { Type } from "typebox";
import { COMMAND_DETAILS_SCHEMA, projectCommandDetails } from "../../code-mode/tool-results.ts";
import type { ExecSessionManager, UnifiedExecResult } from "./exec-session-manager.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING } from "./output-truncation.ts";
import { formatUnifiedExecResult } from "./unified-exec-format.ts";

const WRITE_STDIN_PARAMETERS = Type.Object({
	process_id: Type.Union([Type.Number(), Type.String()], {
		description: "Process ID or name returned by exec_command.",
	}),
	chars: Type.Optional(
		Type.String({
			description:
				"Bytes to write to stdin. Omit to wait on the process without writing, which returns when it prints or exits.",
		}),
	),
	until: Type.Optional(
		Type.String({
			description:
				"Return as soon as this text appears in output produced after this call. Text printed earlier does not match.",
		}),
	),
	yield_time_ms: Type.Optional(
		Type.Number({
			description:
				"How long to wait in milliseconds before yielding. A write carrying characters defaults to 250. A pure read waits at least 30000 or until the process exits. Pass 0 to take the current state immediately. Values above 120000 are capped.",
		}),
	),
	max_output_tokens: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_OUTPUT_TOKENS_CEILING,
			description: `Ceiling on returned output tokens. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}, capped at ${MAX_OUTPUT_TOKENS_CEILING}.`,
		}),
	),
});

export interface WriteStdinParams {
	process_id: number | string;
	chars?: string;
	until?: string;
	yield_time_ms?: number;
	max_output_tokens?: number;
}

export interface WriteStdinExecutionOptions {
	onResult?: (input: WriteStdinParams, result: UnifiedExecResult) => void;
}

function parseWriteStdinParams(params: unknown): WriteStdinParams {
	if (!params || typeof params !== "object") throw new Error("write_stdin requires a process ID");
	const record = params as Record<string, unknown>;
	const process =
		typeof record.process_id === "number" || typeof record.process_id === "string"
			? record.process_id
			: typeof record.process === "number" || typeof record.process === "string"
				? record.process
				: undefined;
	if (process === undefined) throw new Error("write_stdin requires a process ID");
	return {
		process_id: process,
		chars: typeof record.chars === "string" ? record.chars : undefined,
		until: typeof record.until === "string" && record.until.length > 0 ? record.until : undefined,
		yield_time_ms: typeof record.yield_time_ms === "number" ? record.yield_time_ms : undefined,
		max_output_tokens: typeof record.max_output_tokens === "number" ? record.max_output_tokens : undefined,
	};
}

export function createWriteStdinExecution(sessions: ExecSessionManager, options: WriteStdinExecutionOptions = {}) {
	return {
		name: "write_stdin",
		label: "write_stdin",
		description:
			"Drives a process started by exec_command: writes to its stdin, drains the output produced since the last call, and reports whether it is still running. There is no separate wait or describe tool — `until` blocks until a prompt or build line appears instead of polling in a loop, and `yield_time_ms: 0` returns the current state without waiting.",
		promptSnippet: "Write to, poll, or wait on an exec_command process.",
		parameters: WRITE_STDIN_PARAMETERS,
		nestedResult: {
			details: COMMAND_DETAILS_SCHEMA,
			projectDetails: ({ details }: { details: unknown }) => projectCommandDetails(details),
		},
		async execute(_toolCallId: string, params: unknown) {
			const typed = parseWriteStdinParams(params);
			const command = sessions.describe(typed.process_id)?.command;
			let result: UnifiedExecResult;
			try {
				result = await sessions.write(typed);
				options.onResult?.(typed, result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`write_stdin failed: ${message}`);
			}
			return {
				content: [{ type: "text" as const, text: formatUnifiedExecResult(result, command) }],
				details: result,
				isError: result.exit_code !== undefined && result.exit_code !== 0,
			};
		},
	};
}
