import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type ActivityAnimationOverrides, ComponentStack } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import {
	settleToolCallPreview,
	type TerminalOutputUpdate,
	ToolActivity,
	type ToolActivityView,
	type ToolOutputUpdate,
	type ToolTranscriptStatus,
	toolCallPreview,
} from "pi-libtui/tool";
import type { ExecProcessSnapshot, ExecSessionManager } from "../session-manager.ts";
import type { ExecToolPresentationDetails } from "../tools/presentation.ts";
import { CommandTranscript, type CommandTranscriptView } from "./command-transcript.ts";

type ProcessSnapshotSource = Pick<ExecSessionManager, "subscribeProcesses">;
type ProcessSnapshotSourceFactory = () => ProcessSnapshotSource;

interface RendererContext {
	readonly toolCallId?: string;
	readonly executionStarted: boolean;
	readonly state?: object;
	readonly args?: { readonly cmd?: string; readonly shell?: string; readonly session_id?: number };
	readonly isError: boolean;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
}

export function renderExecCommandCall(
	args: { cmd: string; shell?: string },
	theme: Theme,
	context: RendererContext,
	animation?: Readonly<ActivityAnimationOverrides>,
) {
	if (context.executionStarted) return new ComponentStack();
	return toolCallPreview(
		context.state ?? context,
		new CommandTranscript({
			theme,
			requestRender: context.invalidate,
			animation,
			view: { command: args.cmd, shell: args.shell, status: "queued" },
		}),
	);
}

export function renderWriteStdinCall(
	_args: { session_id: number; chars?: string },
	_theme: Theme,
	_context: RendererContext,
) {
	return new ComponentStack();
}

export function renderExecResult(
	result: AgentToolResult<ExecToolPresentationDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RendererContext,
	animation?: Readonly<ActivityAnimationOverrides>,
	processes?: ProcessSnapshotSourceFactory,
) {
	settleToolCallPreview(context.state ?? context);
	if (
		isExecDetails(result.details) &&
		result.details.arguments.kind === "write_stdin" &&
		!context.isError &&
		result.details.outcome.status !== "failed"
	) {
		if (context.lastComponent instanceof ExecPresentation) {
			context.lastComponent.update(
				result.details,
				options.expanded,
				false,
				context.executionStarted,
				context.toolCallId,
			);
			return context.lastComponent;
		}
		return new ComponentStack();
	}
	if (!isExecDetails(result.details)) {
		const fallbackCommand = commandFromFallback(result.details, context);
		if (!fallbackCommand) {
			return new ToolActivity({
				theme,
				requestRender: context.invalidate,
				view: {
					action: { verb: "Command failed", status: "failed" },
					failure: textContent(result) || "Command failed",
				},
			});
		}
		return new CommandTranscript({
			theme,
			requestRender: context.invalidate,
			animation,
			view: {
				command: fallbackCommand,
				shell: context.args?.shell,
				status: "failed",
				failure: textContent(result) || "Command failed",
			},
		});
	}
	const processSource =
		context.executionStarted &&
		result.details.phase === "final" &&
		result.details.outcome.status === "running" &&
		result.details.identifiers.sessionId !== null
			? processes?.()
			: undefined;
	if (context.lastComponent instanceof ExecPresentation) {
		context.lastComponent.update(
			result.details,
			options.expanded,
			context.isError,
			context.executionStarted,
			undefined,
			processSource,
		);
		return context.lastComponent;
	}
	return new ExecPresentation(
		theme,
		context.invalidate,
		result.details,
		options.expanded,
		context.isError,
		context.executionStarted,
		animation,
		processSource,
	);
}

function isExecDetails(details: ExecToolPresentationDetails | undefined): details is ExecToolPresentationDetails {
	const value: TranscriptValue = details;
	if (!isRecord(value)) return false;
	const args = value.arguments;
	const progress = value.progress;
	const timing = value.timing;
	const identifiers = value.identifiers;
	const outcome = value.outcome;
	if (!isRecord(args) || !isRecord(progress) || !isRecord(timing) || !isRecord(identifiers) || !isRecord(outcome)) {
		return false;
	}
	const commonArguments =
		isNullableFiniteNumber(args.requestedYieldTimeMs) && isNullableFiniteNumber(args.maxOutputTokens);
	const validArguments =
		args.kind === "exec_command"
			? typeof args.command === "string" &&
				typeof args.workingDirectory === "string" &&
				typeof args.shell === "string" &&
				typeof args.tty === "boolean" &&
				typeof args.login === "boolean" &&
				commonArguments
			: args.kind === "write_stdin" &&
				isFiniteNumber(args.sessionId) &&
				(args.tty === undefined || typeof args.tty === "boolean") &&
				(args.operation === "poll" || args.operation === "write") &&
				isFiniteNumber(args.inputBytes) &&
				commonArguments;
	return (
		value.contract === "pi-exec-command/tool-presentation" &&
		value.version === 1 &&
		(value.tool === "exec_command" || value.tool === "write_stdin") &&
		value.tool === args.kind &&
		(value.phase === "partial" || value.phase === "final") &&
		(typeof value.command === "string" || value.command === null) &&
		validArguments &&
		isFiniteNumber(timing.wallTimeSeconds) &&
		typeof progress.output === "string" &&
		isFiniteNumber(progress.outputChars) &&
		isFiniteNumber(progress.originalTokenCount) &&
		typeof progress.outputTruncated === "boolean" &&
		(typeof identifiers.chunkId === "string" || identifiers.chunkId === null) &&
		isNullableFiniteNumber(identifiers.sessionId) &&
		(outcome.status === "running" || outcome.status === "succeeded" || outcome.status === "failed") &&
		isNullableFiniteNumber(outcome.exitCode) &&
		(typeof outcome.failure === "string" || outcome.failure === null)
	);
}

// Transcript values originate outside this package despite the host's generic annotation.
type TranscriptValue = unknown;

function isRecord(value: TranscriptValue): value is Record<string, TranscriptValue> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: TranscriptValue): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: TranscriptValue): value is number | null {
	return value === null || isFiniteNumber(value);
}

function textContent(result: AgentToolResult<ExecToolPresentationDetails>): string {
	return (Array.isArray(result.content) ? result.content : [])
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const type = Reflect.get(item, "type");
			const text = Reflect.get(item, "text");
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

function commandFromFallback(
	details: ExecToolPresentationDetails | undefined,
	context: RendererContext,
): string | undefined {
	if (context.args?.cmd) return context.args.cmd;
	if (context.args?.session_id !== undefined) return `terminal #${context.args.session_id}`;
	if (!isRecord(details)) return undefined;
	const command = details.command;
	if (typeof command === "string" && command.length > 0) return command;
	const args = details.arguments;
	if (isRecord(args)) {
		const argumentCommand = args.command;
		if (typeof argumentCommand === "string" && argumentCommand.length > 0) return argumentCommand;
		const sessionId = args.sessionId;
		if (isFiniteNumber(sessionId)) return `terminal #${sessionId}`;
	}
	return undefined;
}

class ExecPresentation {
	private readonly transcript: CommandTranscript | ToolActivity;
	/** Monotonic stream revision; output text and retention remain in pi-libtui. */
	private outputRevision = 0;
	private execDetails: ExecToolPresentationDetails | undefined;
	private readonly continuationOutput = new Map<string, string>();
	private latestContinuation: ExecToolPresentationDetails | undefined;
	private output: string;
	private snapshotOutput: string | undefined;
	private unsubscribeProcesses: (() => void) | undefined;
	private subscribedSessionId: number | undefined;
	private expanded: boolean;
	private hostError: boolean;
	private live: boolean;

	constructor(
		theme: Theme,
		private readonly requestRender: () => void,
		details: ExecToolPresentationDetails,
		expanded: boolean,
		hostError: boolean,
		live: boolean,
		animation?: Readonly<ActivityAnimationOverrides>,
		processes?: ProcessSnapshotSource,
	) {
		this.expanded = expanded;
		this.hostError = hostError;
		this.live = live;
		if (details.outcome.status !== "running") this.stopProcessUpdates();
		this.output = details.progress.output;
		if (details.arguments.kind === "exec_command") this.execDetails = details;
		const revision = this.nextOutputRevision();
		this.transcript =
			details.arguments.kind === "exec_command"
				? new CommandTranscript({
						theme,
						requestRender,
						animation,
						view: commandView(details, expanded, hostError, live, revision),
					})
				: new ToolActivity({
						theme,
						requestRender,
						view: terminalContinuationView(details, expanded, hostError, live, revision),
						textSelection: "tail",
					});
		this.syncProcess(details, processes);
	}

	update(
		details: ExecToolPresentationDetails,
		expanded: boolean,
		hostError: boolean,
		live: boolean,
		continuationId?: string,
		processes?: ProcessSnapshotSource,
	): void {
		this.expanded = expanded;
		this.hostError = hostError;
		this.live = live;
		if (details.outcome.status !== "running") this.stopProcessUpdates();
		if (details.arguments.kind === "exec_command") {
			this.execDetails = details;
			this.output = this.mergedOutput();
			this.syncProcess(details, processes);
			if (this.latestContinuation && this.transcript instanceof CommandTranscript) {
				const continuation = continuationDetails(details, this.latestContinuation, this.output);
				this.transcript.update(commandView(continuation, expanded, hostError, live, this.nextOutputRevision()));
				return;
			}
		}
		if (details.arguments.kind === "write_stdin" && this.execDetails && this.transcript instanceof CommandTranscript) {
			const key = continuationId ?? details.identifiers.chunkId ?? "continuation";
			this.continuationOutput.set(key, details.progress.output);
			this.latestContinuation = details;
			this.output = this.mergedOutput();
			const continuation = continuationDetails(this.execDetails, details, this.output);
			this.transcript.update(commandView(continuation, expanded, hostError, live, this.nextOutputRevision()));
			return;
		}
		const revision = this.nextOutputRevision();
		if (this.transcript instanceof CommandTranscript) {
			this.transcript.update(commandView(details, expanded, hostError, live, revision));
		} else {
			this.transcript.update(terminalContinuationView(details, expanded, hostError, live, revision));
		}
	}

	private mergedOutput(): string {
		return (
			this.snapshotOutput ??
			`${this.execDetails?.progress.output ?? ""}${[...this.continuationOutput.values()].join("")}`
		);
	}

	private syncProcess(details: ExecToolPresentationDetails, processes: ProcessSnapshotSource | undefined): void {
		const sessionId = details.identifiers.sessionId;
		if (!this.live || sessionId === null || !processes?.subscribeProcesses) return;
		if (this.subscribedSessionId === sessionId) return;
		this.unsubscribeProcesses?.();
		this.unsubscribeProcesses = undefined;
		this.subscribedSessionId = sessionId;
		let settled = false;
		let subscribing = true;
		const unsubscribe = processes.subscribeProcesses((snapshots) => {
			const snapshot = snapshots.find(({ id }) => id === sessionId);
			if (!snapshot) return;
			this.acceptProcessSnapshot(snapshot);
			if (!subscribing) this.requestRender();
			settled ||= snapshot.state === "exited";
		});
		subscribing = false;
		this.unsubscribeProcesses = unsubscribe;
		if (settled) this.stopProcessUpdates();
	}

	private acceptProcessSnapshot(snapshot: ExecProcessSnapshot): void {
		if (!this.execDetails || !(this.transcript instanceof CommandTranscript)) return;
		this.snapshotOutput = snapshot.output;
		this.execDetails = snapshotDetails(this.execDetails, snapshot);
		this.output = this.mergedOutput();
		this.transcript.update(
			commandView(this.execDetails, this.expanded, this.hostError, this.live, this.nextOutputRevision()),
		);
		if (snapshot.state === "exited") this.stopProcessUpdates();
	}

	private stopProcessUpdates(): void {
		this.unsubscribeProcesses?.();
		this.unsubscribeProcesses = undefined;
		this.subscribedSessionId = undefined;
	}

	private nextOutputRevision(): number {
		this.outputRevision += 1;
		return this.outputRevision;
	}

	render(width: number): string[] {
		return this.transcript.render(width);
	}

	get children() {
		return this.transcript.children;
	}

	getSpans() {
		return this.transcript.getSpans();
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.transcript.onMouse(event);
	}

	invalidate(): void {
		this.transcript.invalidate();
	}

	dispose(): void {
		this.stopProcessUpdates();
		this.transcript.dispose();
	}
}

function snapshotDetails(
	base: ExecToolPresentationDetails,
	snapshot: ExecProcessSnapshot,
): ExecToolPresentationDetails {
	const exited = snapshot.state === "exited";
	const exitCode = exited ? (snapshot.exitCode ?? 1) : null;
	return {
		...base,
		phase: exited ? "final" : "partial",
		timing: {
			wallTimeSeconds: Math.max(0, (snapshot.finishedAtMs ?? Date.now()) - snapshot.startedAtMs) / 1_000,
		},
		progress: {
			...base.progress,
			output: snapshot.output,
			outputChars: snapshot.output.length,
			outputTruncated: snapshot.outputTruncated,
		},
		identifiers: { ...base.identifiers, sessionId: exited ? null : snapshot.id },
		outcome: {
			status: exited ? (exitCode === 0 ? "succeeded" : "failed") : "running",
			exitCode,
			failure: exited && exitCode !== 0 ? `Process exited with code ${exitCode}` : null,
		},
	};
}

function continuationDetails(
	base: ExecToolPresentationDetails,
	continuation: ExecToolPresentationDetails,
	output: string,
): ExecToolPresentationDetails {
	return {
		...base,
		phase: "partial",
		timing: continuation.timing,
		progress: {
			...continuation.progress,
			output,
			outputChars: output.length,
		},
		identifiers: { ...base.identifiers, chunkId: continuation.identifiers.chunkId },
		outcome: continuation.outcome,
	};
}

function commandView(
	details: ExecToolPresentationDetails,
	expanded: boolean,
	hostError: boolean,
	live: boolean,
	outputRevision: number,
): CommandTranscriptView {
	const status = toolStatus(details, hostError);
	const output = details.progress.output || undefined;
	return {
		command: command(details),
		shell: details.arguments.kind === "exec_command" ? details.arguments.shell : undefined,
		status,
		running: live && status === "running",
		output,
		outputRevision,
		tty: details.arguments.tty,
		outputUpdate: outputUpdate(details),
		meta: metadata(details),
		// Shell output is the useful failure detail. Do not add a disclosure whose
		// only extra row restates the exit status already present in the action.
		failure: output ? undefined : (details.outcome.failure ?? undefined),
		expanded,
	};
}

function terminalContinuationView(
	details: ExecToolPresentationDetails,
	expanded: boolean,
	hostError: boolean,
	live: boolean,
	outputRevision: number,
): ToolActivityView {
	const status = toolStatus(details, hostError);
	const operation = details.arguments.kind === "write_stdin" ? details.arguments.operation : "poll";
	const active = live && status === "running";
	const update = outputUpdate(details);
	const verb =
		operation === "write"
			? active
				? "Sending terminal input"
				: "Sent terminal input"
			: active
				? "Waiting for terminal"
				: "Waited for terminal";
	return {
		action: {
			verb,
			status,
			marker: operation === "write" ? "↳" : "◌",
			detail:
				operation === "write" && details.arguments.kind === "write_stdin"
					? `${details.arguments.inputBytes} bytes · #${details.arguments.sessionId}`
					: details.arguments.kind === "write_stdin"
						? `#${details.arguments.sessionId}`
						: undefined,
			meta: metadata(details),
		},
		running: active,
		payload: details.progress.output
			? details.arguments.tty !== false
				? {
						kind: "terminal" as const,
						text: details.progress.output,
						revision: outputRevision,
						update,
					}
				: {
						kind: "text" as const,
						text: details.progress.output,
						revision: outputRevision,
						update: update === "cumulative-tail" ? "replace" : update,
					}
			: undefined,
		failure: details.outcome.failure ?? undefined,
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
}

function outputUpdate(details: ExecToolPresentationDetails): TerminalOutputUpdate {
	return details.arguments.tty === false ? plainOutputUpdate(details) : terminalOutputUpdate(details);
}

function plainOutputUpdate(details: ExecToolPresentationDetails): ToolOutputUpdate {
	return details.phase === "partial" && !details.progress.outputTruncated ? "cumulative" : "replace";
}

function terminalOutputUpdate(details: ExecToolPresentationDetails): TerminalOutputUpdate {
	if (details.phase !== "partial") return "replace";
	return details.progress.outputTruncated ? "cumulative-tail" : "cumulative";
}

function toolStatus(details: ExecToolPresentationDetails, hostError: boolean): ToolTranscriptStatus {
	if (hostError || details.outcome.status === "failed") return "failed";
	if (details.outcome.status === "running") return "running";
	return "succeeded";
}

function command(details: ExecToolPresentationDetails): string {
	if (details.command) return details.command;
	return details.arguments.kind === "exec_command"
		? details.arguments.command
		: `terminal #${details.arguments.sessionId}`;
}

function metadata(details: ExecToolPresentationDetails): string[] | undefined {
	const failed = details.outcome.status === "failed";
	const running = details.outcome.status === "running";
	const values = [
		running && details.identifiers.sessionId !== null ? `#${details.identifiers.sessionId}` : undefined,
		failed && details.outcome.exitCode !== null ? `exit ${details.outcome.exitCode}` : undefined,
		details.progress.outputTruncated ? "truncated" : undefined,
		!running && details.timing.wallTimeSeconds >= 1 ? formatDuration(details.timing.wallTimeSeconds) : undefined,
	].filter((value): value is string => value !== undefined);
	return values.length ? values : undefined;
}

function formatDuration(seconds: number): string {
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
