import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "../../shared/tool-registry.ts";
import { createExecCommandExecution, type ExecCommandExecutionOptions } from "./exec-command-execution.ts";
import {
	createExecCommandPresentation,
	type ExecCommandPresentationIntents,
	type ExecCommandPresentationState,
	type ExecCommandSessionSnapshot,
} from "./exec-command-presentation.ts";
import type { ExecCommandTracker } from "./exec-command-state.ts";
import type { ExecSessionManager } from "./exec-session-manager.ts";

export type { BackgroundCaptureContext } from "./exec-command-execution.ts";

export interface ExecCommandToolOptions extends ExecCommandExecutionOptions {
	presentation?: {
		state: ExecCommandPresentationState;
		intents: ExecCommandPresentationIntents;
	};
}

function sessionPresentationSnapshot(
	sessions: ExecSessionManager,
	sessionId: number,
): ExecCommandSessionSnapshot | undefined {
	const snapshot = sessions.getSessionSnapshot?.(sessionId);
	if (snapshot) return snapshot;
	const command = sessions.getSessionCommand?.(sessionId);
	return command === undefined ? undefined : { command, running: false, output: "", elapsedMs: 0 };
}

export function registerExecCommandTool(
	pi: ExtensionAPI,
	tracker: ExecCommandTracker,
	sessions: ExecSessionManager,
	options: ExecCommandToolOptions = {},
): void {
	const presentation = options.presentation ?? {
		state: {
			getRenderInfo: (toolCallId, command) => tracker.getRenderInfo(toolCallId, command),
			getSessionSnapshot: (sessionId) => sessionPresentationSnapshot(sessions, sessionId),
		},
		intents: {
			registerRenderContext: (toolCallId, invalidate) => tracker.registerRenderContext(toolCallId, invalidate),
		},
	};
	registerTool(pi, {
		...createExecCommandExecution(tracker, sessions, options),
		...createExecCommandPresentation(presentation.state, presentation.intents),
	});
}
