export type AgentTreeItem = { readonly id: string; readonly parentId?: string };

/** Last segment of a canonical agent path, e.g. `/root/task1/task-3` -> `task-3`. */
export function agentDisplayName(id: string | undefined): string | undefined {
	return id?.split("/").filter(Boolean).at(-1);
}
export type AgentTreeRow<T extends AgentTreeItem> = {
	readonly agent: T;
	readonly prefix: string;
};

export function agentTreeRows<T extends AgentTreeItem>(agents: readonly T[]): readonly AgentTreeRow<T>[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const children = new Map<string | undefined, T[]>();
	for (const agent of agents) {
		const parent = agent.parentId && byId.has(agent.parentId) ? agent.parentId : undefined;
		const siblings = children.get(parent) ?? [];
		siblings.push(agent);
		children.set(parent, siblings);
	}
	for (const siblings of children.values()) siblings.sort((left, right) => left.id.localeCompare(right.id));

	const rows: AgentTreeRow<T>[] = [];
	const visited = new Set<string>();
	const walk = (parent: string | undefined, ancestorLast: readonly boolean[]) => {
		const siblings = children.get(parent) ?? [];
		for (const [index, agent] of siblings.entries()) {
			if (visited.has(agent.id)) continue;
			visited.add(agent.id);
			const last = index === siblings.length - 1;
			const indent = ancestorLast.map((isLast) => (isLast ? "  " : "│ ")).join("");
			rows.push({ agent, prefix: `${indent}${last ? "└─" : "├─"}` });
			walk(agent.id, [...ancestorLast, last]);
		}
	};
	walk(undefined, []);
	return rows;
}

export function agentsWithAncestors<T extends AgentTreeItem>(
	agents: readonly T[],
	include: (agent: T) => boolean,
): readonly T[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const included = new Set(agents.filter(include).map((agent) => agent.id));
	for (const id of [...included]) {
		let parent = byId.get(id)?.parentId;
		while (parent) {
			included.add(parent);
			parent = byId.get(parent)?.parentId;
		}
	}
	return agents.filter((agent) => included.has(agent.id));
}
