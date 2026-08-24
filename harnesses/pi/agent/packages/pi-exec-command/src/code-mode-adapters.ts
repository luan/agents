import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	codeModeFunctionToolAdapter,
	type CodeModeFunctionToolOptions,
	type CodeModeToolAdapter,
	registerCodeModeToolAdapter,
} from "pi-code-mode/sdk";
import type { UnifiedExecResult } from "./session-manager.ts";
import type { createExecCommandTool } from "./tools/exec-command/definition.ts";
import type { ExecToolPresentationDetails } from "./tools/presentation.ts";
import type { createWriteStdinTool } from "./tools/write-stdin/definition.ts";

export type { CodeModeToolAdapter } from "pi-code-mode/sdk";

type CodeModeExecTool = ReturnType<typeof createExecCommandTool> | ReturnType<typeof createWriteStdinTool>;
type ExecCommandTool = ReturnType<typeof createExecCommandTool>;
type WriteStdinTool = ReturnType<typeof createWriteStdinTool>;

function createCodeModeAdapter(tool: CodeModeExecTool, owner: object = tool): CodeModeToolAdapter {
	const options: CodeModeFunctionToolOptions<ExecToolPresentationDetails> = {
		outputSchema: {
			type: "object",
			properties: {
				chunk_id: { type: "string", description: "Chunk identifier included when the response reports one." },
				wall_time_seconds: { type: "number", description: "Elapsed wall time spent waiting for output in seconds." },
				output: { type: "string", description: "Command output text, possibly truncated." },
				exit_code: { type: "integer", description: "Process exit code when the command finished during this call." },
				session_id: {
					type: "integer",
					description: "Session identifier to pass to write_stdin when the process is still running.",
				},
				original_token_count: {
					type: "integer",
					description: "Approximate token count before output truncation.",
				},
				output_truncated: { type: "boolean", description: "Whether returned output was truncated." },
			},
			required: ["chunk_id", "wall_time_seconds", "output", "output_truncated"],
			additionalProperties: false,
		},
		resultValue(result: AgentToolResult<ExecToolPresentationDetails>) {
			return nestedExecResult(result.details as ExecToolPresentationDetails);
		},
	};
	const adapter =
		"cmd" in tool.parameters.properties
			? codeModeFunctionToolAdapter(tool as ExecCommandTool, options)
			: codeModeFunctionToolAdapter(tool as WriteStdinTool, options);
	return { ...adapter, owner, presentationKey: execPresentationKey };
}

function execPresentationKey(
	trace: Parameters<NonNullable<CodeModeToolAdapter["presentationKey"]>>[0],
): string | undefined {
	const details = trace.result?.details;
	if (!details || typeof details !== "object") return undefined;
	if (Reflect.get(details, "contract") !== "pi-exec-command/tool-presentation") return undefined;
	const tool = Reflect.get(details, "tool");
	const arguments_ = Reflect.get(details, "arguments");
	const identifiers = Reflect.get(details, "identifiers");
	const sessionId =
		tool === "write_stdin" && arguments_ && typeof arguments_ === "object"
			? Reflect.get(arguments_, "sessionId")
			: tool === "exec_command" && identifiers && typeof identifiers === "object"
				? Reflect.get(identifiers, "sessionId")
				: undefined;
	return typeof sessionId === "number" && Number.isFinite(sessionId)
		? `pi-exec-command/session/${sessionId}`
		: undefined;
}

function nestedExecResult(details: ExecToolPresentationDetails): UnifiedExecResult {
	return {
		chunk_id: details.identifiers.chunkId ?? "",
		wall_time_seconds: details.timing.wallTimeSeconds,
		output: details.progress.output,
		...(details.outcome.exitCode === null ? {} : { exit_code: details.outcome.exitCode }),
		...(details.identifiers.sessionId === null ? {} : { session_id: details.identifiers.sessionId }),
		original_token_count: details.progress.originalTokenCount,
		output_truncated: details.progress.outputTruncated,
	};
}

export function registerCodeModeExecAdapters(tools: readonly CodeModeExecTool[], owner?: object): () => void {
	const disposers = tools.map((tool) => registerCodeModeToolAdapter(createCodeModeAdapter(tool, owner)));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
