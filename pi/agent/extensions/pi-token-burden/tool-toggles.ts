import { readFileSync } from "node:fs";

export type ToolToggleConfig = {
	disabledTools: string[];
};

export type ToolToggleResult = {
	applied: boolean;
	activeToolNames: string[];
};

type Handler = (...args: any[]) => unknown;

type ToolApi = {
	getActiveTools(): string[];
	setActiveTools(next: string[]): void;
	on(event: string, handler: Handler): void;
};

export const DEFAULT_DISABLED_TOOLS = ["ls", "grab", "find"];

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function normalizeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeToolNames(values: unknown): string[] {
	if (!Array.isArray(values)) return DEFAULT_DISABLED_TOOLS;
	const normalized = values.map(normalizeToolName).filter((value): value is string => Boolean(value));
	return normalized.length ? [...new Set(normalized)] : DEFAULT_DISABLED_TOOLS;
}

export function loadToolToggleConfig(configPath: string): ToolToggleConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<ToolToggleConfig>;
		return { disabledTools: normalizeToolNames(parsed.disabledTools) };
	} catch {
		return { disabledTools: DEFAULT_DISABLED_TOOLS };
	}
}

function toolNameParts(toolName: string): string[] {
	const baseName = toolName.split(".").at(-1);
	return baseName && baseName !== toolName ? [toolName, baseName] : [toolName];
}

function matchesToolName(candidate: string, target: string): boolean {
	const candidateParts = toolNameParts(candidate.toLowerCase());
	const targetParts = toolNameParts(target.toLowerCase());
	return candidateParts.some((part) => targetParts.includes(part));
}

export function createToolToggleController(pi: ToolApi, initiallyDisabledTools: string[]) {
	const disabledTools = new Set(normalizeToolNames(initiallyDisabledTools));

	const isDisabled = (toolName: string) =>
		toolNameParts(toolName.toLowerCase()).some((part) => disabledTools.has(part));

	const isActive = (toolName: string) =>
		pi.getActiveTools().some((activeToolName) => matchesToolName(activeToolName, toolName));

	const removeDisabledTools = () => {
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => !isDisabled(toolName));
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	const setToolActive = (toolName: string, enabled: boolean): ToolToggleResult => {
		const normalized = normalizeToolName(toolName);
		if (!normalized) {
			return { applied: false, activeToolNames: pi.getActiveTools() };
		}

		const active = pi.getActiveTools();
		let next = active;

		if (enabled) {
			for (const part of toolNameParts(normalized)) {
				disabledTools.delete(part);
			}
			if (!active.some((activeToolName) => matchesToolName(activeToolName, normalized))) {
				next = [...active, toolName];
			}
		} else {
			disabledTools.add(normalized);
			next = active.filter((activeToolName) => !matchesToolName(activeToolName, normalized));
		}

		if (!arraysEqual(active, next)) pi.setActiveTools(next);
		return { applied: true, activeToolNames: next };
	};

	const install = () => {
		pi.on("session_start", removeDisabledTools);
		pi.on("session_tree", removeDisabledTools);
		pi.on("model_select", removeDisabledTools);
		pi.on("before_agent_start", removeDisabledTools);
		pi.on("tool_call", (event) => {
			const toolName = normalizeToolName(event.toolName);
			if (!toolName || !isDisabled(toolName) || isActive(toolName)) return;
			return {
				block: true,
				reason: `${toolName} is disabled by the token-burden extension. Toggle it on from /token-burden if needed.`,
			};
		});
	};

	return {
		install,
		setToolActive,
		getActiveToolNames: () => pi.getActiveTools(),
	};
}
