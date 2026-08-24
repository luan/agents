import { CONTEXT_WINDOW_PREFERENCES } from "pi-libcontext/sdk";
import type { TuiForegroundColor } from "pi-libtui";
import { createSettings, listSetting, type ListDefinition, type SettingDefinitionInput } from "pi-xsettings/sdk";
import {
	catalogError,
	cloneCatalog,
	DEFAULT_MODEL_ROLE_CATALOG,
	MODEL_ROLES_SCHEMA,
	ROLE_COLORS,
	THINKING_LEVELS,
	type ModelRoleCatalog,
} from "../core/catalog.ts";
import { roleColor } from "./role-colors.ts";

const THINKING_COLORS = {
	off: { hue: "gray", shade: 2 },
	minimal: { hue: "gray", shade: 3 },
	low: { hue: "cyan", shade: 2 },
	medium: { hue: "cyan", shade: 3 },
	high: { hue: "blue", shade: 3 },
	xhigh: { hue: "magenta", shade: 3 },
	max: { hue: "red", shade: 4 },
} as const satisfies Readonly<Record<string, TuiForegroundColor>>;

const ROLE_COLOR_MAP = Object.fromEntries(ROLE_COLORS.map((color) => [color, roleColor(color)])) as Readonly<
	Record<string, TuiForegroundColor>
>;
const ROUTING_COLORS = { standard: "text.muted", priority: "positive" } as const satisfies Readonly<
	Record<string, TuiForegroundColor>
>;
const option = (value: string, label = value, description = "", color?: TuiForegroundColor) => ({
	value,
	label,
	description,
	...(color ? { color } : {}),
});

const CONTEXT_WINDOW_LABELS: Readonly<
	Record<(typeof CONTEXT_WINDOW_PREFERENCES)[number], { label: string; description: string }>
> = {
	default: { label: "Default", description: "Follow the Codex Native session context setting." },
	smart: { label: "Smart (180k)", description: "Best for short coding tasks in the model's smart zone." },
	balanced: { label: "Balanced (272k)", description: "Codex-preferred default window." },
	enhanced: { label: "Enhanced (400k)", description: "Large tasks that may finish without compaction." },
	large: { label: "Large (600k)", description: "Large projects and long-running orchestration." },
	max: { label: "Max (1M)", description: "Maximum context; quality may degrade at this size." },
};
const CONTEXT_WINDOW_OPTIONS = CONTEXT_WINDOW_PREFERENCES.map((value) =>
	option(value, CONTEXT_WINDOW_LABELS[value].label, CONTEXT_WINDOW_LABELS[value].description),
);

const candidateList: ListDefinition = {
	itemLabel: "Candidate",
	identity: "model",
	uniqueIdentity: false,
	summary: [
		{ path: ["thinking"], colors: THINKING_COLORS },
		{ path: ["serviceTier"], colors: ROUTING_COLORS },
	],
	minItems: 1,
	newItem: {
		model: "openai-codex/gpt-5.6-sol",
		thinking: "medium",
		serviceTier: "standard",
		contextWindow: "default",
	},
	fields: [
		{
			key: "model",
			label: "Model",
			description: "Provider and model used by this candidate.",
			shortcut: "m",
			type: "enum",
			options: { source: "models" },
		},
		{
			key: "thinking",
			label: "Thinking",
			description: "Reasoning effort for this candidate.",
			shortcut: "t",
			type: "enum",
			options: THINKING_LEVELS.map((value) => option(value, value, "", THINKING_COLORS[value])),
		},
		{
			key: "serviceTier",
			label: "Routing",
			description: "Standard or priority provider routing.",
			shortcut: "f",
			type: "enum",
			options: [
				option("standard", "Standard", "", ROUTING_COLORS.standard),
				option("priority", "Fast", "Request priority routing when the provider supports it.", ROUTING_COLORS.priority),
			],
		},
		{
			key: "contextWindow",
			label: "Context",
			description: "Optional Codex context-window override.",
			shortcut: "w",
			type: "enum",
			options: CONTEXT_WINDOW_OPTIONS,
		},
	],
};

const roleList: ListDefinition = {
	itemLabel: "Role",
	identity: "name",
	uniqueIdentity: true,
	identityColor: { path: ["color"], colors: ROLE_COLOR_MAP },
	summary: [
		{ path: ["candidates", 0, "model"], color: "text.muted" },
		{ path: ["candidates", 0, "thinking"], colors: THINKING_COLORS },
		{ path: ["description"], color: "text.muted" },
	],
	minItems: 1,
	newItem: {
		name: "role",
		color: "blue",
		description: "",
		candidates: [candidateList.newItem],
	},
	fields: [
		{ key: "name", label: "Name", description: "Unique role name used by /role and the picker.", type: "string" },
		{ key: "description", label: "Description", description: "When this role should be selected.", type: "string" },
		{
			key: "color",
			label: "Color",
			description: "Color used by the picker and status line.",
			shortcut: "c",
			type: "enum",
			options: ROLE_COLORS.map((value) => option(value, value, "", roleColor(value))),
		},
		{
			key: "candidates",
			label: "Candidates",
			description: "Ordered model fallbacks for this role.",
			shortcut: "m",
			type: "list",
			list: candidateList,
		},
	],
};

const definitions = {
	defaultRole: {
		label: "Default role",
		description: "Role selected for sessions without an explicit choice.",
		category: "behavior",
		type: "enum",
		default: DEFAULT_MODEL_ROLE_CATALOG.defaultRole,
		options: { source: "setting", setting: "roles", field: "name" },
	},
	subagentDefaultRole: {
		label: "Subagent role",
		description: "Default role for future delegated agents.",
		category: "behavior",
		type: "enum",
		default: DEFAULT_MODEL_ROLE_CATALOG.subagentDefaultRole,
		options: { source: "setting", setting: "roles", field: "name" },
	},
	roles: listSetting(MODEL_ROLES_SCHEMA, {
		label: "Roles",
		description: "Ordered model, thinking, and fallback profiles.",
		category: "behavior",
		default: DEFAULT_MODEL_ROLE_CATALOG.roles,
		list: roleList,
	}),
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-model-roles", label: "Model Roles", definitions });

export function getModelRoleCatalog(): ModelRoleCatalog {
	const current = settings.get();
	const catalog = {
		defaultRole: current.defaultRole,
		subagentDefaultRole: current.subagentDefaultRole,
		roles: current.roles,
	};
	return cloneCatalog(catalogError(catalog) ? DEFAULT_MODEL_ROLE_CATALOG : catalog);
}

export const registerModelRoleSettings = settings.register;
