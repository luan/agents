import {
	formatResourceUri,
	type Resource,
	type ResourceContext,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
} from "../../shared/resources.ts";
import { type PersistedAgent, readAgentRegistry, readRetainedAgentRegistries } from "./persistence.ts";

function agentId(ref: ResourceRef): string | undefined {
	const path = ref.path.replace(/^\/+/, "");
	return path || (ref.authority === "current" || ref.authority === "all" ? undefined : ref.authority);
}

function rootSessionId(ref: ResourceRef, context: ResourceContext | undefined): string | undefined {
	if (ref.authority === "current") return context?.sessionId;
	if (ref.authority === "all" || !ref.path) return undefined;
	return ref.authority;
}

function agentResource(ref: ResourceRef, agent: PersistedAgent): Resource {
	return {
		uri: formatResourceUri(ref),
		name: agent.id,
		title: agent.description,
		kind: "subagent",
		mediaType: "application/json",
		modifiedAt: new Date(agent.completedAt ?? agent.startedAt).toISOString(),
	};
}

function allAgents(ref: ResourceRef, context: ResourceContext | undefined): PersistedAgent[] {
	const root = rootSessionId(ref, context);
	return root ? readAgentRegistry(root) : readRetainedAgentRegistries();
}

export function agentResourceProvider(): ResourceProvider {
	return {
		async read(ref, context) {
			const id = agentId(ref);
			if (!id) throw new Error(`Agent URI needs an agent ID: ${formatResourceUri(ref)}`);
			const agent = allAgents(ref, context).find((item) => item.id === id);
			if (!agent) throw new Error(`Agent not found: ${formatResourceUri(ref)}`);
			const content = JSON.stringify(agent, null, 2);
			return {
				resource: { ...agentResource(ref, agent), size: Buffer.byteLength(content, "utf8") },
				content,
			};
		},
		async search(request): Promise<SearchHit[]> {
			if (request.scope?.scheme !== "agent") return [];
			const query = request.query.trim().toLowerCase();
			if (!query) return [];
			return allAgents(request.scope, request.context)
				.filter((agent) => JSON.stringify(agent).toLowerCase().includes(query))
				.slice(0, request.limit ?? 50)
				.map((agent) => ({
					...agentResource(
						{
							scheme: "agent",
							authority: request.scope!.authority,
							path: `/${agent.id}`,
							query: {},
						},
						agent,
					),
					snippet: agent.result ?? agent.error ?? agent.description,
					score: 1,
				}));
		},
		async find(ref, context) {
			return allAgents(ref, context).map((agent) =>
				agentResource(
					{
						scheme: "agent",
						authority: ref.authority,
						path: `/${agent.id}`,
						query: {},
					},
					agent,
				),
			);
		},
	};
}
