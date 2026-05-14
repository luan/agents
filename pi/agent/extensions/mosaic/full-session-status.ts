export type FullSessionAgentRuntimeStatus = "running" | "completed" | "error" | "stopped";

export interface FullSessionTranscriptStatus {
	hasAssistantMessage: boolean;
	assistantTimestamp?: number;
	result?: string;
	error?: string;
}

export interface FullSessionStatusInput {
	currentStatus: FullSessionAgentRuntimeStatus;
	live?: { busy: boolean };
	transcript: FullSessionTranscriptStatus;
	now: number;
}

export interface FullSessionStatusResult {
	status: FullSessionAgentRuntimeStatus;
	completedAt?: number;
	result?: string;
	error?: string;
	activityText: string;
}

export function isTerminalAssistantMessage(message: { stopReason?: unknown; content?: unknown }): boolean {
	if (message.stopReason === "toolUse") return false;
	if (!Array.isArray(message.content)) return true;
	return !message.content.some(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
	);
}

export function resolveFullSessionAgentStatus(input: FullSessionStatusInput): FullSessionStatusResult {
	const { currentStatus, live, transcript, now } = input;

	if (transcript.hasAssistantMessage) {
		const status = transcript.error ? "error" : "completed";
		return {
			status,
			result: transcript.result,
			error: transcript.error,
			completedAt: transcript.assistantTimestamp ?? now,
			activityText: transcript.result || transcript.error || "mosaic target completed",
		};
	}

	if (currentStatus === "stopped" && live) {
		return {
			status: "running",
			activityText: live.busy ? "running in mosaic target" : "idle in mosaic target",
		};
	}

	if (currentStatus !== "running") {
		return {
			status: currentStatus,
			completedAt: now,
			activityText:
				currentStatus === "stopped" ? "mosaic target closed before producing output" : "mosaic target completed",
		};
	}

	if (live?.busy) {
		return {
			status: "running",
			activityText: "running in mosaic target",
		};
	}

	if (!live) {
		return {
			status: "stopped",
			completedAt: now,
			error: "mosaic target closed before producing an assistant message",
			activityText: "mosaic target closed before producing output",
		};
	}

	return {
		status: "running",
		activityText: "idle in mosaic target",
	};
}
