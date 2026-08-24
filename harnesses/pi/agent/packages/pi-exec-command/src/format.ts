import type { UnifiedExecResult } from "./session-manager.ts";

export function formatExecResult(result: UnifiedExecResult, command?: string): string {
	const lines: string[] = [];
	if (command) lines.push(`Command: ${command}`);
	lines.push(`Chunk ID: ${result.chunk_id}`);
	lines.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);
	if (result.exit_code !== undefined) lines.push(`Process exited with code ${result.exit_code}`);
	if (result.session_id !== undefined) lines.push(`Session ${result.session_id} still running.`);
	if (result.original_token_count !== undefined) lines.push(`Original token count: ${result.original_token_count}`);
	lines.push("Output:", result.output);
	return lines.join("\n");
}
