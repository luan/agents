import { expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { boundTraceResult } from "../../src/runtime/trace-values.ts";

test("preserves exec presentation identity and outcome when output is huge", () => {
	const result = {
		content: [],
		details: {
			contract: "pi-exec-command/tool-presentation",
			version: 1,
			tool: "exec_command",
			phase: "final",
			arguments: { kind: "exec_command", command: "large-output" },
			command: "large-output",
			timing: { wallTimeSeconds: 1.2 },
			progress: {
				output: "x".repeat(100_000),
				outputChars: 100_000,
				originalTokenCount: 50_000,
				outputTruncated: false,
			},
			identifiers: { chunkId: "chunk-1", sessionId: null },
			outcome: { status: "succeeded", exitCode: 0, failure: null },
		},
	} as AgentToolResult<unknown>;

	const details = boundTraceResult(result).details as {
		contract: string;
		progress: { output: string };
		identifiers: { chunkId: string; sessionId: null };
		outcome: { status: string; exitCode: number; failure: null };
	};

	expect(details.contract).toBe("pi-exec-command/tool-presentation");
	expect(details.progress.output).toContain("[Trace value truncated]");
	expect(details.progress.output.length).toBeLessThanOrEqual(32_768);
	expect(details.identifiers).toEqual({ chunkId: "chunk-1", sessionId: null });
	expect(details.outcome).toEqual({ status: "succeeded", exitCode: 0, failure: null });
});
