import { getSupportedThinkingLevels, type Api, type Model, type Static, Type } from "@earendil-works/pi-ai";
import type { ModelRegistry, ScopedModel } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ROLE_COLORS = ["gray", "red", "green", "yellow", "blue", "magenta", "cyan"] as const;

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
const RoleColorSchema = Type.Union([
	Type.Literal("gray"),
	Type.Literal("red"),
	Type.Literal("green"),
	Type.Literal("yellow"),
	Type.Literal("blue"),
	Type.Literal("magenta"),
	Type.Literal("cyan"),
]);

const ContextWindowPreferenceSchema = Type.Union([
	Type.Literal("default"),
	Type.Literal("smart"),
	Type.Literal("balanced"),
	Type.Literal("enhanced"),
	Type.Literal("large"),
	Type.Literal("max"),
]);
const LegacyRoleCandidateSchema = Type.Object(
	{
		model: Type.String({ minLength: 3, pattern: "^[^/\\s]+/[^/\\s]+$" }),
		thinking: ThinkingLevelSchema,
		serviceTier: Type.Union([Type.Literal("standard"), Type.Literal("priority")]),
	},
	{ additionalProperties: false },
);
export const ROLE_CANDIDATE_SCHEMA = Type.Union([
	Type.Object(
		{
			model: Type.String({ minLength: 3, pattern: "^[^/\\s]+/[^/\\s]+$" }),
			thinking: ThinkingLevelSchema,
			serviceTier: Type.Union([Type.Literal("standard"), Type.Literal("priority")]),
			contextWindow: ContextWindowPreferenceSchema,
		},
		{ additionalProperties: false },
	),
	LegacyRoleCandidateSchema,
]);

export const MODEL_ROLE_SCHEMA = Type.Object(
	{
		name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9._-]*$" }),
		color: RoleColorSchema,
		description: Type.String(),
		candidates: Type.Array(ROLE_CANDIDATE_SCHEMA, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const MODEL_ROLES_SCHEMA = Type.Array(MODEL_ROLE_SCHEMA, { minItems: 1 });

export const MODEL_ROLE_CATALOG_SCHEMA = Type.Object(
	{
		defaultRole: Type.String(),
		subagentDefaultRole: Type.String(),
		roles: MODEL_ROLES_SCHEMA,
	},
	{ additionalProperties: false },
);

export type RoleCandidate = Static<typeof ROLE_CANDIDATE_SCHEMA>;
export type ModelRole = Static<typeof MODEL_ROLE_SCHEMA>;
export type ModelRoleCatalog = Static<typeof MODEL_ROLE_CATALOG_SCHEMA>;
export type ModelRoleName = string;
export type ModelRoleColor = ModelRole["color"];
export type ModelServiceTier = "standard" | "priority";
export type ModelWithServiceTier = Model<Api> & { serviceTier?: ModelServiceTier };

export function withServiceTier(model: Model<Api>, serviceTier: ModelServiceTier): ModelWithServiceTier {
	return { ...model, serviceTier };
}

export const DEFAULT_MODEL_ROLE_CATALOG: ModelRoleCatalog = {
	defaultRole: "balanced",
	subagentDefaultRole: "task",
	roles: [
		{
			name: "tiny",
			candidates: [
				{ model: "openai-codex/gpt-5.6-luna", thinking: "low", serviceTier: "standard", contextWindow: "default" },
			],
			color: "cyan",
			description:
				"Use for bounded mechanical tasks, quick fact-finding, and narrow codebase searches where latency and cost matter and independent judgment is not required.",
		},
		{
			name: "smol",
			candidates: [
				{ model: "openai-codex/gpt-5.6-luna", thinking: "high", serviceTier: "standard", contextWindow: "default" },
			],
			color: "yellow",
			description: "Use for routine tasks that need more reasoning while keeping cost low.",
		},
		{
			name: "quick",
			candidates: [
				{ model: "openai-codex/gpt-5.6-sol", thinking: "low", serviceTier: "standard", contextWindow: "default" },
			],
			color: "blue",
			description: "Use for time-sensitive small tasks that need a strong model with light reasoning.",
		},
		{
			name: "balanced",
			candidates: [
				{ model: "openai-codex/gpt-5.6-sol", thinking: "medium", serviceTier: "standard", contextWindow: "default" },
			],
			color: "green",
			description:
				"Use for nuanced review, careful tradeoff analysis, and tasks that need strong independent judgment.",
		},
		{
			name: "task",
			candidates: [
				{ model: "openai-codex/gpt-5.6-luna", thinking: "xhigh", serviceTier: "standard", contextWindow: "default" },
			],
			color: "magenta",
			description:
				"Use for substantial delegated coding tasks that need sustained autonomous reasoning and clear ownership of an implementation outcome.",
		},
	],
};

export interface ResolvedModelRole {
	requestedRole: string;
	role: ModelRole;
	candidate: RoleCandidate;
	model: Model<Api>;
}

export function cloneCatalog(catalog: ModelRoleCatalog): ModelRoleCatalog {
	return {
		defaultRole: catalog.defaultRole,
		subagentDefaultRole: catalog.subagentDefaultRole,
		roles: catalog.roles.map((role) => ({
			...role,
			candidates: role.candidates.map((candidate) => ({ ...candidate })),
		})),
	};
}

export function roleNames(catalog: ModelRoleCatalog): string[] {
	return catalog.roles.map((role) => role.name);
}

export function roleByName(catalog: ModelRoleCatalog, name: string): ModelRole | undefined {
	return catalog.roles.find((role) => role.name === name);
}

export function isModelRoleName(catalog: ModelRoleCatalog, value: string): boolean {
	return roleByName(catalog, value) !== undefined;
}

export function catalogError(catalog: ModelRoleCatalog): string | undefined {
	if (catalog.roles.length === 0) return "Keep at least one model role.";
	const names = roleNames(catalog);
	if (names.some((name) => !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name))) return "A role name is invalid.";
	if (new Set(names).size !== names.length) return "Role names must be unique.";
	if (catalog.roles.some((role) => role.candidates.length === 0)) return "Each role needs at least one candidate.";
	if (!names.includes(catalog.defaultRole)) return "The default role must exist.";
	if (!names.includes(catalog.subagentDefaultRole)) return "The subagent default role must exist.";
	return undefined;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function availableModels(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	scopedModels: readonly ScopedModel[],
): Model<Api>[] {
	return scopedModels.length > 0 ? scopedModels.map(({ model }) => model) : modelRegistry.getAvailable();
}

export function resolveModelRole(
	requestedRole: string,
	catalog: ModelRoleCatalog,
	models: readonly Model<Api>[],
): ResolvedModelRole | undefined {
	const direct = resolveCandidate(requestedRole, roleByName(catalog, requestedRole), models);
	return (
		direct ??
		(requestedRole === catalog.defaultRole
			? undefined
			: resolveCandidate(requestedRole, roleByName(catalog, catalog.defaultRole), models))
	);
}

function resolveCandidate(
	requestedRole: string,
	role: ModelRole | undefined,
	models: readonly Model<Api>[],
): ResolvedModelRole | undefined {
	if (!role) return undefined;
	const byKey = new Map(models.map((model) => [modelKey(model), model]));
	for (const candidate of role.candidates) {
		const model = byKey.get(candidate.model);
		if (!model || !getSupportedThinkingLevels(model).includes(candidate.thinking)) continue;
		return { requestedRole, role, candidate, model };
	}
	return undefined;
}
