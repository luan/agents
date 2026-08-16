import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentCustomMessageRendererResolver, AgentToolRendererResolver } from "./agent-browser.js";

type PresentationSession = {
	sessionManager: { getSessionId(): string };
	getToolDefinition(name: string): ReturnType<AgentToolRendererResolver>;
	extensionRunner: { getMessageRenderer(customType: string): ReturnType<AgentCustomMessageRendererResolver> };
};

const PATCHED = Symbol.for("agents.subagents.presentation-resolver.patched");
const sessions = new Map<string, PresentationSession>();

function remember(session: PresentationSession): void {
	sessions.set(session.sessionManager.getSessionId(), session);
}

export function getPresentationResolver(sessionId: string):
	| {
			resolveTool: AgentToolRendererResolver;
			resolveCustomMessage: AgentCustomMessageRendererResolver;
	  }
	| undefined {
	const session = sessions.get(sessionId);
	if (!session) return undefined;
	return {
		resolveTool: (name) => session.getToolDefinition(name),
		resolveCustomMessage: (customType) => session.extensionRunner.getMessageRenderer(customType),
	};
}

export function unregisterPresentationResolver(sessionId: string): void {
	sessions.delete(sessionId);
}

type Patchable = Record<PropertyKey, unknown>;
const agentPrototype = AgentSession.prototype as unknown as Patchable;
if (!agentPrototype[PATCHED]) {
	const original = agentPrototype._tryExecuteExtensionCommand as (
		this: PresentationSession,
		text: string,
	) => Promise<boolean>;
	agentPrototype._tryExecuteExtensionCommand = function (this: PresentationSession, text: string) {
		remember(this);
		return original.call(this, text);
	};
	agentPrototype[PATCHED] = true;
}

// InteractiveMode is not in the package export map. Resolve it from the public
// package entry so this presentation-only patch does not hard-code a checkout path.
const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const interactiveUrl = new URL("./modes/interactive/interactive-mode.js", packageEntry);
const { InteractiveMode } = (await import(interactiveUrl.href)) as { InteractiveMode: { prototype: Patchable } };
const interactivePrototype = InteractiveMode.prototype;
if (!interactivePrototype[PATCHED]) {
	const original = interactivePrototype.setupExtensionShortcuts as (
		this: { session: PresentationSession },
		runner: unknown,
	) => void;
	interactivePrototype.setupExtensionShortcuts = function (this: { session: PresentationSession }, runner: unknown) {
		remember(this.session);
		return original.call(this, runner);
	};
	interactivePrototype[PATCHED] = true;
}
