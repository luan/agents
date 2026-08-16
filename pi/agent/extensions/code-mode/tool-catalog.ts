import { getRegisteredTools, type RegisteredToolDefinition } from "../shared/tool-registry.ts";
import { ToolReach } from "../token-burden/types.ts";
import { defaultToolReach, getToolPolicy, isSessionDeniedTool } from "../tool-policy/policy.ts";
import { asTomlRegisteredTool, discoverTomlTools, type TomlTool } from "./toml-tools.ts";
import { renderParameterList } from "./tool-declarations.ts";

export interface UnifiedCatalogEntry {
	name: string;
	description: string;
	input: string;
	parameters?: unknown;
	reach: ToolReach;
	definition?: RegisteredToolDefinition;
	toml?: TomlTool;
}

export function unifiedCatalog(sessionId?: string, cwd = process.cwd()): UnifiedCatalogEntry[] {
	const policy = getToolPolicy(sessionId);
	const entries: UnifiedCatalogEntry[] = [];
	const names = new Set<string>();
	for (const [name, definition] of getRegisteredTools(sessionId)) {
		if (policy?.isHidden(name) || isSessionDeniedTool(sessionId, name)) continue;
		const configuredReach = (policy?.toolReach ?? defaultToolReach)(name);
		if (configuredReach !== ToolReach.Declared && configuredReach !== ToolReach.Deferred) continue;
		const toml = definition.tomlTool as TomlTool | undefined;
		const reach = toml?.deferLoading ? ToolReach.Deferred : configuredReach;
		names.add(name);
		entries.push({
			name,
			description: typeof definition.description === "string" ? definition.description : "",
			input: renderParameterList(definition.parameters),
			parameters: definition.parameters,
			reach,
			definition,
			...(toml ? { toml } : {}),
		});
	}
	for (const toml of discoverTomlTools(cwd).tools) {
		if (names.has(toml.name) || isSessionDeniedTool(sessionId, toml.name) || policy?.isHidden(toml.name)) continue;
		entries.push({
			name: toml.name,
			description: toml.description || toml.usage,
			input: "input: string",
			parameters: {
				type: "object",
				properties: { input: { type: "string", description: toml.usage } },
				required: ["input"],
			},
			reach: toml.deferLoading ? ToolReach.Deferred : ToolReach.Declared,
			toml,
			definition: asTomlRegisteredTool(toml),
		});
	}
	return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export function unifiedTool(name: string, cwd = process.cwd(), sessionId?: string): UnifiedCatalogEntry | undefined {
	return unifiedCatalog(sessionId, cwd).find((entry) => entry.name === name);
}
