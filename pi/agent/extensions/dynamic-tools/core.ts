import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface DynamicToolPredicate {
	path: string;
	exists?: boolean;
	equals?: JsonValue;
	truthy?: boolean;
	matches?: string;
}

export interface DynamicToolConditions {
	input?: DynamicToolPredicate[];
	result?: DynamicToolPredicate[];
}

export interface DynamicToolRule {
	id: string;
	from: string;
	to: string[];
	enabled: boolean;
	when?: DynamicToolConditions;
	freshRun?: boolean;
	continuation?: string;
}

export interface DynamicToolsConfig {
	roots: string[];
	rules: DynamicToolRule[];
}

export interface DynamicToolEvent {
	toolName: string;
	input: Record<string, unknown>;
	result: unknown;
}

export interface DynamicToolMatch {
	rule: DynamicToolRule;
	newlyActivated: string[];
	continuation?: string;
}

export interface DynamicToolEvaluation {
	matches: DynamicToolMatch[];
}

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
export const DYNAMIC_TOOLS_CONFIG_PATH = join(EXTENSION_DIR, "config.json");

export const DEFAULT_DYNAMIC_TOOLS_CONFIG: DynamicToolsConfig = {
	roots: [],
	rules: [
		{
			id: "exec-command-tty-write-stdin",
			from: "exec_command",
			to: ["write_stdin"],
			enabled: true,
			when: {
				input: [{ path: "tty", equals: true }],
				result: [{ path: "session_id", exists: true }],
			},
			freshRun: true,
			continuation:
				"Continue the previous interactive terminal task. Use write_stdin with session_id {{result.session_id}}; do not start a replacement exec_command for that session.",
		},
	],
};

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

export function normalizeDynamicToolPredicates(value: unknown): DynamicToolPredicate[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const predicates = value.flatMap((item): DynamicToolPredicate[] => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		if (typeof record.path !== "string" || record.path.trim().length === 0) return [];
		const predicate: DynamicToolPredicate = { path: record.path };
		if (typeof record.exists === "boolean") predicate.exists = record.exists;
		if ("equals" in record && isJsonValue(record.equals)) predicate.equals = record.equals;
		if (typeof record.truthy === "boolean") predicate.truthy = record.truthy;
		if (typeof record.matches === "string") predicate.matches = record.matches;
		return [predicate];
	});
	return predicates.length > 0 ? predicates : undefined;
}

function normalizeConditions(value: unknown): DynamicToolConditions | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const input = normalizeDynamicToolPredicates(record.input);
	const result = normalizeDynamicToolPredicates(record.result);
	return input || result ? { input, result } : undefined;
}

function normalizeRule(value: unknown): DynamicToolRule | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.from !== "string") return undefined;
	const to = typeof record.to === "string" ? [record.to] : normalizeStringArray(record.to);
	if (to.length === 0) return undefined;
	return {
		id: record.id,
		from: record.from,
		to,
		enabled: record.enabled !== false,
		when: normalizeConditions(record.when),
		freshRun: record.freshRun === true,
		continuation: typeof record.continuation === "string" ? record.continuation : undefined,
	};
}

export function normalizeDynamicToolsConfig(value: unknown): DynamicToolsConfig {
	if (!value || typeof value !== "object") return DEFAULT_DYNAMIC_TOOLS_CONFIG;
	const record = value as Record<string, unknown>;
	const rules = Array.isArray(record.rules)
		? record.rules.flatMap((item) => {
				const rule = normalizeRule(item);
				return rule ? [rule] : [];
			})
		: DEFAULT_DYNAMIC_TOOLS_CONFIG.rules;
	return {
		roots: normalizeStringArray(record.roots),
		rules,
	};
}

export function loadDynamicToolsConfig(configPath = DYNAMIC_TOOLS_CONFIG_PATH): DynamicToolsConfig {
	if (!existsSync(configPath)) {
		saveDynamicToolsConfig(DEFAULT_DYNAMIC_TOOLS_CONFIG, configPath);
		return DEFAULT_DYNAMIC_TOOLS_CONFIG;
	}
	return normalizeDynamicToolsConfig(JSON.parse(readFileSync(configPath, "utf8")));
}

export function saveDynamicToolsConfig(config: DynamicToolsConfig, configPath = DYNAMIC_TOOLS_CONFIG_PATH): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function managedDynamicTools(config: DynamicToolsConfig): Set<string> {
	return new Set(config.rules.flatMap((rule) => rule.to));
}

export function validateDynamicToolDag(config: DynamicToolsConfig): string[] {
	const graph = new Map<string, string[]>();
	for (const rule of config.rules) {
		if (!rule.enabled) continue;
		graph.set(rule.from, [...(graph.get(rule.from) ?? []), ...rule.to]);
	}

	const diagnostics: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string, trail: string[]): void => {
		if (visiting.has(node)) {
			diagnostics.push(`Cycle detected: ${[...trail, node].join(" -> ")}`);
			return;
		}
		if (visited.has(node)) return;
		visiting.add(node);
		for (const next of graph.get(node) ?? []) visit(next, [...trail, node]);
		visiting.delete(node);
		visited.add(node);
	};

	for (const node of graph.keys()) visit(node, []);
	return diagnostics;
}

export function evaluateDynamicToolRules(
	config: DynamicToolsConfig,
	event: DynamicToolEvent,
	activeDynamicTools: Set<string>,
): DynamicToolEvaluation {
	const matches: DynamicToolMatch[] = [];

	for (const rule of config.rules) {
		if (!rule.enabled || rule.from !== event.toolName || !matchesConditions(rule.when, event)) continue;
		const newlyActivated = rule.to.filter((tool) => !activeDynamicTools.has(tool));
		for (const tool of newlyActivated) activeDynamicTools.add(tool);
		matches.push({
			rule,
			newlyActivated,
			continuation: rule.continuation ? renderTemplate(rule.continuation, event) : undefined,
		});
	}

	return { matches };
}

export function shouldTerminateForDynamicTools(
	config: DynamicToolsConfig,
	event: DynamicToolEvent,
	activeToolNames: string[],
): boolean {
	const active = new Set(activeToolNames);
	return config.rules.some(
		(rule) =>
			rule.enabled &&
			rule.freshRun === true &&
			rule.from === event.toolName &&
			rule.to.some((tool) => !active.has(tool)) &&
			matchesConditions(rule.when, event),
	);
}

function matchesConditions(conditions: DynamicToolConditions | undefined, event: DynamicToolEvent): boolean {
	if (!conditions) return true;
	return matchesPredicates(conditions.input, event.input) && matchesPredicates(conditions.result, event.result);
}

function matchesPredicates(predicates: DynamicToolPredicate[] | undefined, value: unknown): boolean {
	if (!predicates || predicates.length === 0) return true;
	return predicates.every((predicate) => matchesPredicate(predicate, value));
}

function matchesPredicate(predicate: DynamicToolPredicate, root: unknown): boolean {
	const value = getPath(root, predicate.path);
	if (predicate.exists !== undefined && (value !== undefined) !== predicate.exists) return false;
	if ("equals" in predicate && !jsonEquals(value, predicate.equals)) return false;
	if (predicate.truthy !== undefined && Boolean(value) !== predicate.truthy) return false;
	if (predicate.matches !== undefined) {
		if (typeof value !== "string") return false;
		if (!new RegExp(predicate.matches).test(value)) return false;
	}
	return true;
}

function getPath(root: unknown, path: string): unknown {
	let current = root;
	for (const part of path.split(".")) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function renderTemplate(template: string, event: DynamicToolEvent): string {
	return template.replace(/\{\{\s*(input|result)\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, root: string, path: string) => {
		const value = getPath(root === "input" ? event.input : event.result, path);
		return value === undefined || value === null ? "" : String(value);
	});
}

function jsonEquals(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true;
	if (["boolean", "number", "string"].includes(typeof value)) return true;
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(isJsonValue);
}
