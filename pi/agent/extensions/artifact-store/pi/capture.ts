import { artifactStoreFor } from "../../shared/artifact-store.ts";
import { capMiddleByBytes, safeSliceByBytes } from "../../shared/output-budget.ts";
import { getCurrentArtifactSession } from "./current-session.js";

// exec streams into a buffer before anything bounds it, so `exec-command/tools/output-truncation.ts` reads this cap to stop growing the buffer.
// It matches the store's inline read limit, so a captured artifact is always one an `artifact://` read can return whole.
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_PREVIEW_BYTES = 8_192;
const SUCCESS_TAIL_LINES = 20;
const CAPTURE_MIDDLE_NOTICE = "\n\n[Artifact capture capped at 8 MiB; the omitted middle is unavailable.]\n\n";
const CAPTURE_TAIL_NOTICE = "\n\n[Artifact capture truncated at 8 MiB; the omitted tail is unavailable.]";

export interface Capture {
	artifactId: string;
	byteCount: number;
	lineCount: number;
	returnedBytes: number;
	omittedBytes: number;
	preview: string;
}

export interface CaptureContext {
	sourceKind?: "command" | "eval" | "read";
	label?: string;
	originalCommand?: string;
	executedCommand?: string;
	/** Explicit owner for callbacks that run after the originating session context ends. */
	ownerSessionId?: string;
	/** An artifact this source already filled. Replaced rather than duplicated, so a drained process keeps one URI. */
	existingUri?: string;
}

export interface CaptureTerminal {
	output: string;
	exitCode?: number;
	terminalState?: string;
}

export interface CapturedExecResult extends CaptureTarget {
	output: string;
	capture_output?: string;
	capture_output_truncated?: boolean;
	exit_code?: number;
	terminal_state?: string;
}

export interface CaptureTarget {
	output: string;
	artifact_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
		returned_bytes: number;
		omitted_bytes: number;
	};
	artifact_capture_failure?: string;
	artifact_capture_truncated?: boolean;
}

export type CaptureOutcome = { capture?: Capture; failure?: string };

function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function suffixBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	// A byte offset can land mid-codepoint; decoding with the built-in replacement
	// behaviour and dropping a leading U+FFFD is cheaper than scanning backwards.
	const buffer = Buffer.from(text, "utf8");
	return buffer.toString("utf8", buffer.length - maxBytes).replace(/^�+/, "");
}

function lastLines(text: string, count: number): string {
	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

// A command that succeeded is read for its outcome, so the last lines answer it. A failed one is read for the diagnostic, wherever it stopped writing, so its tail is raw.
function outputPreview(terminal: CaptureTerminal, artifactId: string, byteCount: number): string {
	if (byteCount <= DEFAULT_PREVIEW_BYTES) return terminal.output;
	const failed =
		(terminal.exitCode !== undefined && terminal.exitCode !== 0) ||
		terminal.terminalState === "cancelled" ||
		terminal.terminalState === "session_error";
	const notice =
		`Captured ${humanBytes(byteCount)} as artifact ${artifactId}; showing ` +
		`${failed ? "diagnostic tail" : `final ${SUCCESS_TAIL_LINES} lines`}. ` +
		`Read artifact://${artifactId} for the captured output.\n`;
	const remaining = DEFAULT_PREVIEW_BYTES - Buffer.byteLength(notice, "utf8");
	if (remaining <= 0) return notice;
	const body = failed ? terminal.output : lastLines(terminal.output, SUCCESS_TAIL_LINES);
	return `${notice}${suffixBytes(body, remaining)}`;
}

function capArtifactOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= CAPTURE_MAX_BYTES) return output;
	const contentBytes = CAPTURE_MAX_BYTES - Buffer.byteLength(CAPTURE_MIDDLE_NOTICE, "utf8");
	return capMiddleByBytes(output, contentBytes, { notice: () => CAPTURE_MIDDLE_NOTICE });
}

export function markCaptureTailTruncated(output: string): string {
	const contentBytes = CAPTURE_MAX_BYTES - Buffer.byteLength(CAPTURE_TAIL_NOTICE, "utf8");
	return `${safeSliceByBytes(output, 0, contentBytes)}${CAPTURE_TAIL_NOTICE}`;
}

export async function captureExecOutput(context: CaptureContext, terminal: CaptureTerminal): Promise<CaptureOutcome> {
	// The artifact directory follows the explicit owner when a background callback outlives ALS.
	const store = artifactStoreFor(getCurrentArtifactSession(context.ownerSessionId));
	const label = context.label ?? context.originalCommand ?? context.executedCommand ?? context.sourceKind ?? "command";
	const existingId = context.existingUri ? /^artifact:\/\/(\d+)$/.exec(context.existingUri)?.[1] : undefined;
	const output = capArtifactOutput(terminal.output);
	const artifactId =
		existingId && (await store.replace(existingId, output)) ? existingId : await store.mint(output, label);
	if (!artifactId) return { failure: "Artifact store unavailable; full output was not captured" };

	const byteCount = Buffer.byteLength(output, "utf8");
	const preview = outputPreview({ ...terminal, output }, artifactId, byteCount);
	const returnedBytes = Buffer.byteLength(preview, "utf8");
	return {
		capture: {
			artifactId,
			byteCount,
			lineCount: output ? output.split("\n").length : 0,
			returnedBytes,
			omittedBytes: Math.max(0, byteCount - returnedBytes),
			preview,
		},
	};
}

/** Capture text that did not come from a command: a read, a search, a resource view. The exec-shaped fields are absent. */
export async function captureContent(context: CaptureContext, output: string): Promise<CaptureOutcome> {
	return captureExecOutput({ sourceKind: "read", ...context }, { output });
}

export async function captureExecResult(context: CaptureContext, result: CapturedExecResult): Promise<CaptureOutcome> {
	const truncated = result.capture_output_truncated === true;
	const output = result.capture_output ?? result.output;
	const artifactOutput = truncated ? markCaptureTailTruncated(output) : output;
	const outcome = await captureExecOutput(context, {
		output: artifactOutput,
		exitCode: result.exit_code,
		terminalState: result.terminal_state,
	});
	applyCaptureOutcome(result, outcome);
	if (truncated && outcome.capture) result.artifact_capture_truncated = true;
	return outcome;
}

export function applyCaptureOutcome(target: CaptureTarget, outcome: CaptureOutcome): void {
	if (outcome.capture) {
		target.output = outcome.capture.preview;
		target.artifact_capture = {
			artifact_id: outcome.capture.artifactId,
			byte_count: outcome.capture.byteCount,
			line_count: outcome.capture.lineCount,
			returned_bytes: outcome.capture.returnedBytes,
			omitted_bytes: outcome.capture.omittedBytes,
		};
	} else if (outcome.failure) {
		target.artifact_capture_failure = outcome.failure;
	}
}
