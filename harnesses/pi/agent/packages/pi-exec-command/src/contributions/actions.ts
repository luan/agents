import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "pi-libactions/sdk";
import type { ProcessHubManager, ProcessHubSource, ProcessTerminalStore } from "../ui/process-store.ts";
import { relatedSessions } from "./session-hierarchy.ts";

interface ProcessHubHost {
	readonly store: ProcessTerminalStore;
	readonly manager: ProcessHubManager;
	open(ctx: ExtensionContext, sources: readonly ProcessHubSource[]): void | Promise<void>;
}

const hosts = new Map<string, ProcessHubHost>();
let actionUsers = 0;
let unregisterAction: (() => void) | undefined;

export function retainProcessHubAction(): () => void {
	actionUsers++;
	unregisterAction ??= registerAction({
		id: "processes.open",
		description: "Open the Process Hub",
		async run(ctx) {
			await openRegisteredProcessHub(ctx);
		},
	});
	let retained = true;
	return () => {
		if (!retained) return;
		retained = false;
		actionUsers--;
		if (actionUsers > 0) return;
		unregisterAction?.();
		unregisterAction = undefined;
	};
}

export async function openRegisteredProcessHub(ctx: ExtensionContext): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const host = hosts.get(sessionId);
	if (!host) {
		ctx.ui.notify("Process Hub is unavailable for this session.", "warning");
		return;
	}
	const sources = relatedSessions(sessionId).flatMap((session) => {
		const related = hosts.get(session.sessionId);
		return related
			? [{ sessionId: session.sessionId, path: session.path, store: related.store, manager: related.manager }]
			: [];
	});
	await host.open(ctx, sources);
}

export function registerProcessHubHost(sessionId: string, host: ProcessHubHost): () => void {
	hosts.set(sessionId, host);
	return () => {
		if (hosts.get(sessionId) === host) hosts.delete(sessionId);
	};
}
