// Every input is an observed output of tool-policy/policy.ts: the active set, the rendered declarations, the block set.
// A name in none of them and absent from code-mode's `buildToolCatalog()` is unreachable, which is a bug state.

import { ToolReach } from "./types.ts";

export interface ToolReachInputs {
	activeToolNames: readonly string[];
	catalogToolNames: readonly string[];
	declaredToolNames: readonly string[];
	isHidden?: (toolName: string) => boolean;
}

export function toolReachResolver(inputs: ToolReachInputs): (toolName: string) => ToolReach {
	const active = new Set(inputs.activeToolNames);
	const catalog = new Set(inputs.catalogToolNames);
	const declared = new Set(inputs.declaredToolNames);
	const isHidden = inputs.isHidden ?? (() => false);

	return (toolName: string): ToolReach => {
		if (isHidden(toolName)) return ToolReach.Blocked;
		if (active.has(toolName)) return ToolReach.Direct;
		if (!catalog.has(toolName)) return ToolReach.Unreachable;
		return declared.has(toolName) ? ToolReach.Declared : ToolReach.Deferred;
	};
}

// The rendered block is what the request paid for, so the names are read back out of it rather than from the config.
export function parseDeclaredToolNames(declarations: string | undefined): string[] {
	if (!declarations) return [];
	return [...declarations.matchAll(/^\s*tools\.([\w.]+)\(/gm)].map((match) => match[1]);
}

export const TOOL_REACH_ORDER: readonly ToolReach[] = [
	ToolReach.Direct,
	ToolReach.Declared,
	ToolReach.Deferred,
	ToolReach.Blocked,
	ToolReach.Unreachable,
];

const REACH_LABELS: Record<ToolReach, string> = {
	[ToolReach.Direct]: "direct",
	[ToolReach.Declared]: "declared",
	[ToolReach.Deferred]: "deferred",
	[ToolReach.Blocked]: "blocked",
	[ToolReach.Unreachable]: "unreachable",
};

export function toolReachLabel(reach: ToolReach): string {
	return REACH_LABELS[reach];
}

const REACH_DESCRIPTIONS: Record<ToolReach, string> = {
	[ToolReach.Direct]: "schema is in the provider's tool array; callable without a cell",
	[ToolReach.Declared]: "callable from a cell; its signature is in the system prompt",
	[ToolReach.Deferred]: "callable from a cell; found by filtering ALL_TOOLS",
	[ToolReach.Blocked]: "refused everywhere, cells included",
	[ToolReach.Unreachable]: "registered, absent from the tool array and from the cell catalog",
};

export function toolReachDescription(reach: ToolReach): string {
	return REACH_DESCRIPTIONS[reach];
}
