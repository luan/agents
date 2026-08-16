export type ExecCommandStatus = "running" | "done";

export interface ExecCommandRenderInfo {
	status: ExecCommandStatus;
	elapsedMs?: number;
	captureWrapped?: boolean;
	sessionId?: number;
	output?: string;
}

interface ExecEntry {
	toolCallId: string;
	command: string;
	status: ExecCommandStatus;
	startedAtMs: number;
	captureWrapped: boolean;
	sessionId?: number;
	output?: string;
	invalidate?: () => void;
}

export interface ExecCommandTracker {
	getRenderInfo(toolCallId: string | undefined, command: string): ExecCommandRenderInfo;
	/** True between `recordStart` and `recordEnd`, which is exactly while a call holds the turn. */
	hasCallInFlight(): boolean;
	registerRenderContext(toolCallId: string | undefined, invalidate: () => void): void;
	recordStart(toolCallId: string, command: string): void;
	recordCaptureWrapped(toolCallId: string): void;
	recordPersistentSession(toolCallId: string, processId: number): void;
	recordOutput(toolCallId: string, output: string): void;
	recordEnd(toolCallId: string): void;
	recordSessionFinished(processId: number): void;
	invalidateSessions(): void;
	clear(): void;
}

export function createExecCommandTracker(): ExecCommandTracker {
	const commandByToolCallId = new Map<string, string>();
	const runningCountsByCommand = new Map<string, number>();
	const sessionBackedToolCallIds = new Set<string>();
	const captureWrappedToolCallIds = new Set<string>();
	const toolCallIdBySessionId = new Map<number, string>();
	const entriesByToolCallId = new Map<string, ExecEntry>();
	const inFlightToolCallIds = new Set<string>();

	function incrementCommand(command: string): void {
		runningCountsByCommand.set(command, (runningCountsByCommand.get(command) ?? 0) + 1);
	}

	function decrementCommand(command: string): void {
		const next = (runningCountsByCommand.get(command) ?? 0) - 1;
		if (next > 0) runningCountsByCommand.set(command, next);
		else runningCountsByCommand.delete(command);
	}

	function elapsedMs(entry: ExecEntry): number | undefined {
		return entry.status === "running" ? Math.max(0, Date.now() - entry.startedAtMs) : undefined;
	}

	return {
		hasCallInFlight() {
			return inFlightToolCallIds.size > 0;
		},
		getRenderInfo(toolCallId, command) {
			const entry = toolCallId ? entriesByToolCallId.get(toolCallId) : undefined;
			if (!entry) {
				return {
					status: (runningCountsByCommand.get(command) ?? 0) > 0 ? "running" : "done",
					captureWrapped: toolCallId ? captureWrappedToolCallIds.has(toolCallId) : false,
				};
			}
			return {
				status: entry.status,
				elapsedMs: elapsedMs(entry),
				captureWrapped: entry.captureWrapped,
				sessionId: entry.sessionId,
				output: entry.output,
			};
		},
		registerRenderContext(toolCallId, invalidate) {
			if (!toolCallId) return;
			const entry = entriesByToolCallId.get(toolCallId);
			if (entry) entry.invalidate = invalidate;
		},
		recordStart(toolCallId, command) {
			inFlightToolCallIds.add(toolCallId);
			const existing = entriesByToolCallId.get(toolCallId);
			commandByToolCallId.set(toolCallId, command);
			incrementCommand(command);
			if (existing) {
				existing.command = command;
				existing.status = "running";
				existing.startedAtMs = Date.now();
				existing.invalidate?.();
				return;
			}
			entriesByToolCallId.set(toolCallId, {
				toolCallId,
				command,
				status: "running",
				startedAtMs: Date.now(),
				captureWrapped: captureWrappedToolCallIds.has(toolCallId),
			});
		},
		recordCaptureWrapped(toolCallId) {
			captureWrappedToolCallIds.add(toolCallId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry || entry.captureWrapped) return;
			entry.captureWrapped = true;
			entry.invalidate?.();
		},
		recordPersistentSession(toolCallId, processId) {
			sessionBackedToolCallIds.add(toolCallId);
			toolCallIdBySessionId.set(processId, toolCallId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			entry.status = "running";
			entry.sessionId = processId;
			entry.invalidate?.();
		},
		recordOutput(toolCallId, output) {
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			entry.output = output;
			entry.invalidate?.();
		},
		recordEnd(toolCallId) {
			inFlightToolCallIds.delete(toolCallId);
			const command = commandByToolCallId.get(toolCallId);
			if (!command) return;
			const entry = entriesByToolCallId.get(toolCallId);
			if (!sessionBackedToolCallIds.has(toolCallId)) {
				decrementCommand(command);
				if (entry) entry.status = "done";
			}
			entry?.invalidate?.();
			commandByToolCallId.delete(toolCallId);
		},
		recordSessionFinished(processId) {
			const toolCallId = toolCallIdBySessionId.get(processId);
			if (!toolCallId) return;
			toolCallIdBySessionId.delete(processId);
			const entry = entriesByToolCallId.get(toolCallId);
			if (!entry) return;
			decrementCommand(entry.command);
			entry.status = "done";
			sessionBackedToolCallIds.delete(toolCallId);
			entry.invalidate?.();
		},
		invalidateSessions() {
			for (const toolCallId of sessionBackedToolCallIds) {
				entriesByToolCallId.get(toolCallId)?.invalidate?.();
			}
		},
		clear() {
			inFlightToolCallIds.clear();
			commandByToolCallId.clear();
			runningCountsByCommand.clear();
			sessionBackedToolCallIds.clear();
			captureWrappedToolCallIds.clear();
			toolCallIdBySessionId.clear();
			entriesByToolCallId.clear();
		},
	};
}
