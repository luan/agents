import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type AgentToolRendererResolver = (name: string) => ToolDefinition | undefined;
export type AgentCustomMessageRenderer = ConstructorParameters<
	typeof import("@earendil-works/pi-coding-agent")["CustomMessageComponent"]
>[1];
export type AgentCustomMessageRendererResolver = (customType: string) => AgentCustomMessageRenderer;

export interface AgentPresentationResolver {
	resolveTool: AgentToolRendererResolver;
	resolveCustomMessage: AgentCustomMessageRendererResolver;
}
export type AgentPresentationResolverLookup = (agentId: string) => AgentPresentationResolver | undefined;

const PRESENTATION_RESOLVERS = Symbol.for("pi.subagents.presentation-resolvers.v1");
const globalResolvers = globalThis as typeof globalThis & {
	[PRESENTATION_RESOLVERS]?: Map<string, AgentPresentationResolver>;
};
const sessions = globalResolvers[PRESENTATION_RESOLVERS] ?? new Map<string, AgentPresentationResolver>();
globalResolvers[PRESENTATION_RESOLVERS] = sessions;

/** Register only public Pi presentation capabilities; no host prototypes are patched. */
export function registerPresentationResolver(agentId: string, resolver: AgentPresentationResolver): () => void {
	sessions.set(agentId, resolver);
	return () => {
		if (sessions.get(agentId) === resolver) sessions.delete(agentId);
	};
}

export function getPresentationResolver(agentId: string): AgentPresentationResolver | undefined {
	return sessions.get(agentId);
}

export function unregisterPresentationResolver(agentId: string): void {
	sessions.delete(agentId);
}
