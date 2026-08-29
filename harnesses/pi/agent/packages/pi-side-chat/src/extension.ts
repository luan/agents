import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "pi-libactions/sdk";
import { ensureSidePanelRegistry, registerSidePanelProvider } from "pi-libtui";
import { SideChatManager } from "./manager.ts";
import { claimSideChatProcesses } from "./process-registry.ts";
import { createSideChatRuntime, writeSideChatSession } from "./session.ts";
import { latestSideChatState } from "./state.ts";

export default function sideChatExtension(pi: ExtensionAPI): void {
	let manager: SideChatManager | undefined;
	let releaseProcesses: (() => void) | undefined;
	let unregisterProvider: (() => void) | undefined;
	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let unregisterAction: (() => void) | undefined;

	pi.on("session_start", (_event, nextContext) => {
		if (nextContext.mode !== "tui" || !nextContext.hasUI) return;
		unregisterProvider?.();
		manager?.dispose();
		releaseProcesses?.();
		const [processes, release] = claimSideChatProcesses(nextContext.sessionManager.getSessionDir(), globalThis);
		releaseProcesses = release;
		manager = new SideChatManager(
			pi,
			nextContext,
			createSideChatRuntime(nextContext, writeSideChatSession),
			latestSideChatState(nextContext.sessionManager.getBranch()) ?? {
				version: 1,
				nextNumber: 1,
				tabs: [],
			},
			randomUUID,
			globalThis,
			processes,
		);
		activeSession = nextContext.sessionManager;
		unregisterAction?.();
		unregisterAction = registerAction({
			id: "side-panel.chat.new",
			description: "Start a new side chat",
			run: () => manager?.newChat(),
		});
		unregisterProvider = registerSidePanelProvider(
			{
				id: "pi-side-chat",
				session: nextContext,
				attach(panel) {
					return manager?.attachPanel(panel);
				},
			},
			globalThis,
		);
		if (!ensureSidePanelRegistry(globalThis).hasHost()) void manager.restoreStandalone();
	});
	pi.on("session_shutdown", (event, context) => {
		if (context.mode !== "tui" || !context.hasUI || activeSession !== context.sessionManager) return;
		unregisterProvider?.();
		unregisterProvider = undefined;
		const preserveProcesses = event.reason === "reload";
		manager?.dispose({ preserveProcesses });
		manager = undefined;
		if (!preserveProcesses) releaseProcesses?.();
		releaseProcesses = undefined;
		activeSession = undefined;
		if (event.reason === "reload" || event.reason === "quit") {
			unregisterAction?.();
			unregisterAction = undefined;
		}
	});

	pi.registerCommand("side", {
		description: "Create an interactive side chat: /side [prompt|close]",
		handler: async (argumentsText: string, commandContext: ExtensionCommandContext) => {
			if (!manager) {
				commandContext.ui.notify("Side chat is unavailable outside an interactive session.", "warning");
				return;
			}
			const argument = argumentsText.trim();
			if (argument === "close") manager.closeActive();
			else await manager.newChat(argument || undefined);
		},
	});
}
