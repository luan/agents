import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../../shared/tool-registry.ts";
import type { ExecSessionManager } from "./exec-session-manager.ts";
import { createWriteStdinExecution, type WriteStdinExecutionOptions } from "./write-stdin-execution.ts";
import {
	createWriteStdinPresentation,
	type WriteStdinPresentationState,
	type WriteStdinSessionSnapshot,
} from "./write-stdin-presentation.ts";

export interface WriteStdinToolOptions extends WriteStdinExecutionOptions {
	presentation?: WriteStdinPresentationState;
}

function sessionPresentationState(
	sessions: ExecSessionManager,
	sessionId: number,
): WriteStdinSessionSnapshot | undefined {
	const snapshot = sessions.getSessionSnapshot?.(sessionId);
	if (snapshot) return snapshot;
	const record = sessions.describe?.(sessionId);
	const command = sessions.getSessionCommand?.(sessionId) ?? record?.command;
	const tty = sessions.getSessionTty?.(sessionId);
	if (command === undefined && tty === undefined && record === undefined) return undefined;
	return {
		command,
		running: record?.running ?? false,
		stdinOpen: record?.running ? record.stdinOpen : undefined,
		tty: tty === true,
	};
}

export function registerWriteStdinTool(
	pi: ExtensionAPI,
	sessions: ExecSessionManager,
	options: WriteStdinToolOptions = {},
): void {
	const presentation = options.presentation ?? {
		getSessionSnapshot: (sessionId) => sessionPresentationState(sessions, sessionId),
	};
	registerTool(pi, {
		...createWriteStdinExecution(sessions, options),
		...createWriteStdinPresentation(presentation),
	});
}
