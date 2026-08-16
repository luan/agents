import type { UnifiedExecResult } from "./exec-session-manager.ts";

function isProcessStillRunning(result: UnifiedExecResult): boolean {
	return (
		result.process_id !== undefined &&
		result.exit_code === undefined &&
		result.terminal_state === undefined &&
		result.cancelled !== true &&
		result.session_error === undefined
	);
}

export function formatUnifiedExecResult(result: UnifiedExecResult, command?: string): string {
	const sections: string[] = [];

	if (command) {
		sections.push(`Command: ${command}`);
	}
	if (result.chunk_id) {
		sections.push(`Chunk ID: ${result.chunk_id}`);
	}
	sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);

	if (result.exit_code !== undefined) {
		sections.push(`Process exited with code ${result.exit_code}`);
	}
	if (result.cancelled) {
		sections.push("Process cancelled");
	}
	if (result.session_error) {
		sections.push(`Session error: ${result.session_error}`);
	}
	if (isProcessStillRunning(result)) {
		sections.push(`Process running with process ID ${result.process_id}`);
		if (result.process_name) {
			sections.push(`Process name: ${result.process_name}`);
		}
		if (result.stdin_open) {
			sections.push("TTY: yes");
		}
	}
	if (result.notice) {
		sections.push(result.notice);
	}
	if (result.until_matched !== undefined) {
		sections.push(result.until_matched ? "Until: matched" : "Until: not seen before the yield expired");
	}
	if (result.original_token_count !== undefined) {
		sections.push(`Original token count: ${result.original_token_count}`);
	}
	if (result.artifact_capture_failure) {
		sections.push(`Artifact capture failed: ${result.artifact_capture_failure}`);
	}
	// A concrete call, not a description of one: the elided bytes are reachable only if the result hands back the way in.
	// Skipped when `artifact_capture` is set, because `capture.ts:85` already put the same URI in the output preview.
	if (result.full_output_ref && !result.artifact_capture) {
		const elided = result.output_elided_bytes ? `${result.output_elided_bytes} bytes elided below. ` : "";
		sections.push(
			`${elided}Everything this process has printed is in ${result.full_output_ref}: ` +
				`read({path: "${result.full_output_ref}"}), or search({path: "${result.full_output_ref}", pattern: "..."}) for one line of it. Polling again returns what comes next, never the elided middle.`,
		);
	}

	sections.push("Output:");
	sections.push(result.output);

	return sections.join("\n");
}
