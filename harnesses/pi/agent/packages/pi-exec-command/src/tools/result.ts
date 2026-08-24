import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatExecResult } from "../format.ts";
import type { UnifiedExecResult } from "../session-manager.ts";
import {
	createExecToolPresentationDetails,
	type ExecToolPresentationArguments,
	type ExecToolPresentationDetails,
} from "./presentation.ts";

interface ResultInput {
	tool: "exec_command" | "write_stdin";
	phase: "partial" | "final";
	arguments: ExecToolPresentationArguments;
	command: string | undefined;
	result?: UnifiedExecResult;
}

export function createExecToolResult(input: ResultInput): AgentToolResult<ExecToolPresentationDetails> {
	return {
		content: input.result === undefined ? [] : [{ type: "text", text: formatExecResult(input.result, input.command) }],
		details: createExecToolPresentationDetails(input),
	};
}
