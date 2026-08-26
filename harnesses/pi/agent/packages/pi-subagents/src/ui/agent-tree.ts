export interface AgentTreeItem {
	readonly id: string;
	readonly parentId?: string;
}

export interface AgentTreeRow<Item extends AgentTreeItem> {
	readonly agent: Item;
	readonly prefix: string;
}

/** Last segment of a canonical agent path, e.g. `/root/task1/task-3` -> `task-3`. */
export function agentDisplayName(id: string | undefined): string | undefined {
	return id?.split("/").filter(Boolean).at(-1);
}

/** Produce a stable depth-first tree without trusting malformed parent cycles. */
export function agentTreeRows<Item extends AgentTreeItem>(agents: readonly Item[]): readonly AgentTreeRow<Item>[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const children = new Map<string | undefined, Item[]>();
	for (const agent of agents) {
		const parent = agent.parentId && byId.has(agent.parentId) ? agent.parentId : undefined;
		const siblings = children.get(parent) ?? [];
		siblings.push(agent);
		children.set(parent, siblings);
	}
	for (const siblings of children.values()) siblings.sort((left, right) => left.id.localeCompare(right.id));

	const rows: AgentTreeRow<Item>[] = [];
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

export function agentsWithAncestors<Item extends AgentTreeItem>(
	agents: readonly Item[],
	include: (agent: Item) => boolean,
): readonly Item[] {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const included = new Set(agents.filter(include).map((agent) => agent.id));
	for (const id of [...included]) {
		let parent = byId.get(id)?.parentId;
		const visited = new Set<string>();
		while (parent && !visited.has(parent)) {
			visited.add(parent);
			included.add(parent);
			parent = byId.get(parent)?.parentId;
		}
	}
	return agents.filter((agent) => included.has(agent.id));
}
