import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const ROLE_COLORS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"syntaxFunction",
	"syntaxString",
	"syntaxType",
	"syntaxNumber",
	"mdLink",
	"success",
	"warning",
	"error",
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

function isRoleColor(value: unknown): value is RoleColor {
	return typeof value === "string" && ROLE_COLORS.includes(value as RoleColor);
}

export function defaultRoleColor(index: number): RoleColor {
	return ROLE_COLORS[Math.max(0, Math.min(index, ROLE_COLORS.length - 1))] ?? "error";
}

export function roleColor(role: ModelRole, index = 0): RoleColor {
	return isRoleColor(role.color) ? role.color : defaultRoleColor(index);
}

export function roleNames(catalog: ModelRoleCatalog): string[] {
	return Object.keys(catalog.roles);
}

export function nextRoleColor(catalog: ModelRoleCatalog): RoleColor {
	const used = new Set(roleNames(catalog).map((name, index) => roleColor(catalog.roles[name]!, index)));
	return ROLE_COLORS.find((color) => !used.has(color)) ?? defaultRoleColor(roleNames(catalog).length);
}

export function moveModelRole(catalog: ModelRoleCatalog, name: string, delta: number): boolean {
	const names = roleNames(catalog);
	const index = names.indexOf(name);
	const target = index + delta;
	if (index < 0 || target < 0 || target >= names.length) return false;
	const entries = Object.entries(catalog.roles);
	const [entry] = entries.splice(index, 1);
	entries.splice(target, 0, entry!);
	catalog.roles = Object.fromEntries(entries);
	return true;
}

export interface RoleCandidate {
	model: string;
	thinking: ThinkingLevel;
	service_tier?: string;
}

export interface ModelRole {
	candidates: RoleCandidate[];
	color?: RoleColor;
	description?: string;
}

export interface ModelRoleCatalog {
	defaultRole: string;
	subagentDefaultRole: string;
	roles: Record<string, ModelRole>;
}

export interface ModelRegistry {
	find(provider: string, modelId: string): any;
	getAvailable?(): any[];
	getAll?(): any[];
}

export interface ResolvedModelRole {
	requestedRole: string;
	roleName: string;
	model: any;
	candidate: RoleCandidate;
}
export function formatRoleCandidate(candidate: RoleCandidate): string {
	const fast = candidate.service_tier === "priority" ? " · fast" : "";
	return `${candidate.model} · ${candidate.thinking}${fast}`;
}

export function formatModelRoleOption(name: string, role: ModelRole, current = false): string {
	const candidate = role.candidates[0];
	const fast = role.candidates.some((entry) => entry.service_tier === "priority") ? " · fast" : "";
	const details = candidate ? `${candidate.model} · ${candidate.thinking}` : "no candidates";
	const fallbacks = role.candidates.length > 1 ? ` · +${role.candidates.length - 1} fallback` : "";
	const description = role.description ? ` — ${role.description}` : "";
	return `${name}${current ? " (current)" : ""} — ${details}${fast}${fallbacks}${description}`;
}

export function saveModelRoles(catalog: ModelRoleCatalog, agentDir = getAgentDir()): void {
	const path = join(agentDir, "model-roles.json");
	writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function parseCandidate(value: unknown): RoleCandidate | undefined {
	const entry = asRecord(value);
	if (!entry || typeof entry.model !== "string" || !THINKING_LEVELS.has(entry.thinking as ThinkingLevel))
		return undefined;
	const candidate: RoleCandidate = {
		model: entry.model.trim(),
		thinking: entry.thinking as ThinkingLevel,
	};
	if (typeof entry.service_tier === "string" && entry.service_tier.trim()) {
		candidate.service_tier = entry.service_tier.trim();
	}
	return candidate.model ? candidate : undefined;
}

export function loadModelRoles(agentDir = getAgentDir()): ModelRoleCatalog {
	const path = join(agentDir, "model-roles.json");
	if (!existsSync(path)) return { defaultRole: "default", subagentDefaultRole: "default", roles: {} };

	try {
		const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
		const rawRoles = asRecord(root?.roles);
		const roles: Record<string, ModelRole> = {};
		for (const [index, [name, value]] of Object.entries(rawRoles ?? {}).entries()) {
			const entry = asRecord(value);
			const candidates = entry?.candidates;
			if (!Array.isArray(candidates)) continue;
			const parsed = candidates
				.map(parseCandidate)
				.filter((candidate): candidate is RoleCandidate => candidate !== undefined);
			if (parsed.length > 0) {
				roles[name] = {
					candidates: parsed,
					color: isRoleColor(entry?.color) ? entry.color : defaultRoleColor(index),
					...(typeof entry?.description === "string" && entry.description.trim()
						? { description: entry.description.trim() }
						: {}),
				};
			}
		}
		const configuredDefault = typeof root?.defaultRole === "string" ? root.defaultRole : undefined;
		const defaultRole =
			configuredDefault && roles[configuredDefault] ? configuredDefault : (Object.keys(roles)[0] ?? "default");
		const configuredSubagentDefault =
			typeof root?.subagentDefaultRole === "string" ? root.subagentDefaultRole : undefined;
		const subagentDefaultRole =
			configuredSubagentDefault && roles[configuredSubagentDefault]
				? configuredSubagentDefault
				: roles.task
					? "task"
					: defaultRole;
		return { defaultRole, subagentDefaultRole, roles };
	} catch (error) {
		console.warn(`[roles] Ignoring malformed ${path}: ${error instanceof Error ? error.message : error}`);
		return { defaultRole: "default", subagentDefaultRole: "default", roles: {} };
	}
}

function resolveCandidate(
	roleName: string,
	role: ModelRole | undefined,
	registry: ModelRegistry,
	requestedRole: string,
): ResolvedModelRole | undefined {
	if (!role) return undefined;
	const available = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
	const availableKeys = new Set(available.map((model) => `${model.provider}/${model.id}`.toLowerCase()));

	for (const candidate of role.candidates) {
		const slash = candidate.model.indexOf("/");
		if (slash <= 0 || slash === candidate.model.length - 1) continue;
		const provider = candidate.model.slice(0, slash);
		const modelId = candidate.model.slice(slash + 1);
		if (!availableKeys.has(`${provider}/${modelId}`.toLowerCase())) continue;
		const model = registry.find(provider, modelId);
		if (!model || !getSupportedThinkingLevels(model).includes(candidate.thinking)) continue;
		return { requestedRole, roleName, model, candidate };
	}
	return undefined;
}

export function resolveModelRole(
	name: string | undefined,
	registry: ModelRegistry,
	catalog: ModelRoleCatalog,
): ResolvedModelRole | undefined {
	const requestedRole = name?.trim() || catalog.defaultRole;
	const direct = resolveCandidate(requestedRole, catalog.roles[requestedRole], registry, requestedRole);
	if (direct) return direct;
	if (requestedRole !== catalog.defaultRole) {
		return resolveCandidate(catalog.defaultRole, catalog.roles[catalog.defaultRole], registry, requestedRole);
	}
	return undefined;
}
