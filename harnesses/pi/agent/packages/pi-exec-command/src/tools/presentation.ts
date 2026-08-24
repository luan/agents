import type { ExecCommandInput, UnifiedExecResult, WriteStdinInput } from "../session-manager.ts";

export const EXEC_TOOL_PRESENTATION_CONTRACT = "pi-exec-command/tool-presentation" as const;
export const EXEC_TOOL_PRESENTATION_VERSION = 1 as const;

export interface ExecCommandPresentationArguments {
	kind: "exec_command";
	command: string;
	workingDirectory: string;
	shell: string;
	tty: boolean;
	login: boolean;
	requestedYieldTimeMs: number | null;
	maxOutputTokens: number | null;
}

export interface WriteStdinPresentationArguments {
	kind: "write_stdin";
	sessionId: number;
	/** Absent in early version-one transcripts; write_stdin sessions are terminal sessions. */
	tty?: boolean;
	operation: "poll" | "write";
	inputBytes: number;
	requestedYieldTimeMs: number | null;
	maxOutputTokens: number | null;
}

export type ExecToolPresentationArguments = ExecCommandPresentationArguments | WriteStdinPresentationArguments;

export interface ExecToolPresentationDetailsV1 {
	contract: typeof EXEC_TOOL_PRESENTATION_CONTRACT;
	version: typeof EXEC_TOOL_PRESENTATION_VERSION;
	tool: "exec_command" | "write_stdin";
	phase: "partial" | "final";
	arguments: ExecToolPresentationArguments;
	command: string | null;
	timing: {
		wallTimeSeconds: number;
	};
	progress: {
		output: string;
		outputChars: number;
		originalTokenCount: number;
		outputTruncated: boolean;
	};
	identifiers: {
		chunkId: string | null;
		sessionId: number | null;
	};
	outcome: {
		status: "running" | "succeeded" | "failed";
		exitCode: number | null;
		failure: string | null;
	};
}

export type ExecToolPresentationDetails = ExecToolPresentationDetailsV1;

export function normalizeExecCommandArguments(
	input: ExecCommandInput,
	workingDirectory: string,
	shell: string,
): ExecCommandPresentationArguments {
	return {
		kind: "exec_command",
		command: input.cmd,
		workingDirectory,
		shell,
		tty: input.tty ?? false,
		login: input.login ?? true,
		requestedYieldTimeMs: input.yield_time_ms ?? null,
		maxOutputTokens: input.max_output_tokens ?? null,
	};
}

export function normalizeWriteStdinArguments(input: WriteStdinInput, tty = false): WriteStdinPresentationArguments {
	const inputBytes = Buffer.byteLength(input.chars ?? "", "utf8");
	return {
		kind: "write_stdin",
		sessionId: input.session_id,
		tty,
		operation: inputBytes === 0 ? "poll" : "write",
		inputBytes,
		requestedYieldTimeMs: input.yield_time_ms ?? null,
		maxOutputTokens: input.max_output_tokens ?? null,
	};
}

export function createExecToolPresentationDetails(input: {
	tool: "exec_command" | "write_stdin";
	phase: "partial" | "final";
	arguments: ExecToolPresentationArguments;
	command: string | undefined;
	result?: UnifiedExecResult;
}): ExecToolPresentationDetails {
	const result = input.result;
	const exitCode = result?.exit_code ?? null;
	const status =
		result === undefined || result.session_id !== undefined ? "running" : exitCode === 0 ? "succeeded" : "failed";
	return {
		contract: EXEC_TOOL_PRESENTATION_CONTRACT,
		version: EXEC_TOOL_PRESENTATION_VERSION,
		tool: input.tool,
		phase: input.phase,
		arguments: input.arguments,
		command: input.command ?? null,
		timing: { wallTimeSeconds: result?.wall_time_seconds ?? 0 },
		progress: {
			output: result?.output ?? "",
			outputChars: result?.output.length ?? 0,
			originalTokenCount: result?.original_token_count ?? 0,
			outputTruncated: result?.output_truncated ?? false,
		},
		identifiers: {
			chunkId: result?.chunk_id ?? null,
			sessionId: result?.session_id ?? null,
		},
		outcome: {
			status,
			exitCode,
			failure: status === "failed" ? `Process exited with code ${exitCode}` : null,
		},
	};
}
