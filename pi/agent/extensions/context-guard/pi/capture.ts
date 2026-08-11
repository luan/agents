import { invokeCore, parseCoreJson } from "./core.js";
import { getStorePath } from "./tool-paths.js";

export const CONTEXT_GUARD_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

const CAPTURE_TIMEOUT_MS = 5_000;

export interface ContextGuardCapture {
	artifactId: string;
	byteCount: number;
	lineCount: number;
	returnedBytes: number;
	omittedBytes: number;
	preview: string;
}

export interface ContextGuardCaptureContext {
	projectDir: string;
	sessionId?: string;
	sourceKind?: "command" | "eval" | "read";
	label?: string;
	metadata?: Record<string, unknown>;
	originalCommand?: string;
	executedCommand?: string;
	cwd?: string;
}

export interface ContextGuardCaptureTerminal {
	output: string;
	exitCode?: number;
	terminalState?: string;
	elapsedMs?: number;
}

export interface ContextGuardCapturedExecResult extends ContextGuardCaptureTarget {
	output: string;
	capture_output?: string;
	capture_output_truncated?: boolean;
	exit_code?: number;
	terminal_state?: string;
	wall_time_seconds?: number;
	elapsed_ms?: number;
}

export interface ContextGuardCaptureTarget {
	output: string;
	context_guard_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
		returned_bytes: number;
		omitted_bytes: number;
	};
	context_guard_capture_failure?: string;
	context_guard_capture_truncated?: boolean;
}

export type ContextGuardCaptureOutcome = { capture?: ContextGuardCapture; failure?: string };

async function recordCaptureFailure(dbPath: string): Promise<void> {
	try {
		await invokeCore("record_failure", { dbPath, operation: "capture" });
	} catch {
		// The capture core may itself be unavailable; command behavior still fails open.
	}
}

export async function captureExecOutput(
	context: ContextGuardCaptureContext,
	terminal: ContextGuardCaptureTerminal,
): Promise<ContextGuardCaptureOutcome> {
	const dbPath = getStorePath(context.projectDir);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await invokeCore(
			"capture",
			{
				dbPath,
				projectDir: context.projectDir,
				sessionId: context.sessionId,
				sourceKind: context.sourceKind ?? "command",
				label: context.label ?? context.originalCommand ?? context.executedCommand,
				metadata: context.metadata ?? {},
				originalCommand: context.originalCommand,
				executedCommand: context.executedCommand,
				cwd: context.cwd ?? context.projectDir,
				output: terminal.output,
				exitCode: terminal.exitCode,
				terminalState: terminal.terminalState,
				elapsedMs: terminal.elapsedMs,
			},
			controller.signal,
		);
		const capture = parseCoreJson<ContextGuardCapture>(response);
		if (capture && typeof capture.preview === "string") return { capture };
		await recordCaptureFailure(dbPath);
		return { failure: response.content[0]?.text || "Context Guard capture failed" };
	} catch (error) {
		await recordCaptureFailure(dbPath);
		return { failure: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Capture text that did not come from a command.
 *
 * A read, a search or a resource view produces output the same way a command
 * does, and loses it the same way when it exceeds the budget. The core stores
 * `source_kind` as a free-form string, so the only exec-shaped fields — exit
 * code, terminal state, elapsed time — are simply absent.
 */
export async function captureContent(
	context: ContextGuardCaptureContext,
	output: string,
): Promise<ContextGuardCaptureOutcome> {
	return captureExecOutput({ sourceKind: "read", ...context }, { output });
}

export async function captureExecResult(
	context: ContextGuardCaptureContext,
	result: ContextGuardCapturedExecResult,
): Promise<ContextGuardCaptureOutcome> {
	const truncated = result.capture_output_truncated === true;
	const output = result.capture_output ?? result.output;
	const outcome = await captureExecOutput(
		truncated
			? {
					...context,
					metadata: {
						...context.metadata,
						captureOutputTruncated: true,
						captureOutputMaxBytes: CONTEXT_GUARD_CAPTURE_MAX_BYTES,
					},
				}
			: context,
		{
			output: truncated
				? `${output}\n\n[Context Guard capture truncated at 8 MiB; the omitted tail is unavailable.]`
				: output,
			exitCode: result.exit_code,
			terminalState: result.terminal_state,
			elapsedMs: result.elapsed_ms ?? Math.round((result.wall_time_seconds ?? 0) * 1000),
		},
	);
	applyCaptureOutcome(result, outcome);
	if (truncated && outcome.capture) result.context_guard_capture_truncated = true;
	return outcome;
}

export function applyCaptureOutcome(target: ContextGuardCaptureTarget, outcome: ContextGuardCaptureOutcome): void {
	if (outcome.capture) {
		target.output = outcome.capture.preview;
		target.context_guard_capture = {
			artifact_id: outcome.capture.artifactId,
			byte_count: outcome.capture.byteCount,
			line_count: outcome.capture.lineCount,
			returned_bytes: outcome.capture.returnedBytes,
			omitted_bytes: outcome.capture.omittedBytes,
		};
	} else if (outcome.failure) {
		target.context_guard_capture_failure = outcome.failure;
	}
}
