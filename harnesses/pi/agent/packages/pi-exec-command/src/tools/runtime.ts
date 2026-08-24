import type { ExecSessionManager } from "../session-manager.ts";

export interface ExecRuntime {
	getManager(): ExecSessionManager;
}
