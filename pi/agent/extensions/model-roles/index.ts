import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { setOpenAIFastRoleEnabled } from "../shared/openai-fast-state";
import { defineExtensionTui } from "../shared/tui";
import {
	loadModelRoles,
	type ModelRoleCatalog,
	type ResolvedModelRole,
	type RoleCandidate,
	resolveModelRole,
} from "./catalog.js";
import { editModelRoles } from "./editor.js";
import { openModelRolePicker } from "./picker.js";
import { isRecord, type RoleScope, selectedRole, updateRoleSelection } from "./selection.js";
import { installSessionOnlySettings } from "./settings.js";

const ROLE_SESSION_ENTRY = "model_role";
const ATTACHED_MODEL_ROLE_ENV = "PI_ATTACHED_AGENT_MODEL_ROLE";
const modelRolesTui = defineExtensionTui({ id: "model-roles" });

type RoleState = {
	roleName: string;
	modelKey: string;
	candidate: RoleCandidate;
};

type RoleSessionManager = ExtensionContext["sessionManager"] & {
	appendCustomEntry(customType: string, data?: unknown): string;
};

function appendRoleSessionEntry(ctx: ExtensionContext, role: string | null): void {
	(ctx.sessionManager as RoleSessionManager).appendCustomEntry(ROLE_SESSION_ENTRY, { role });
}

function attachedModelRole(): string | undefined {
	const role = process.env[ATTACHED_MODEL_ROLE_ENV]?.trim();
	delete process.env[ATTACHED_MODEL_ROLE_ENV];
	return role || undefined;
}
function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function roleLabel(requestedRole: string, resolved: ResolvedModelRole): string {
	return requestedRole === resolved.roleName ? requestedRole : `${requestedRole} (fallback: ${resolved.roleName})`;
}

function sessionRole(ctx: ExtensionContext): string | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== ROLE_SESSION_ENTRY || !isRecord(entry.data)) continue;
		return typeof entry.data.role === "string" ? entry.data.role : undefined;
	}
	return undefined;
}
function updateRoleStatus(ctx: ExtensionContext, state: RoleState | undefined): void {
	const ui = ctx.ui as typeof ctx.ui & { setStatus?: (key: string, text: string | undefined) => void };
	if (!ctx.hasUI || !ui.setStatus) return;
	const status = modelRolesTui.bind(ctx).status;
	if (!state || !ctx.model) {
		status.clear("current");
		return;
	}
	status.set("current", state.roleName);
}
function updateRoleFast(ctx: ExtensionContext, active: boolean): void {
	setOpenAIFastRoleEnabled({
		active,
		sessionFile: ctx.sessionManager.getSessionFile?.() ?? undefined,
	});
}

function rememberRole(states: WeakMap<object, RoleState>, ctx: ExtensionContext, resolved: ResolvedModelRole): void {
	states.set(ctx.sessionManager, {
		roleName: resolved.roleName,
		modelKey: modelKey(resolved.model),
		candidate: resolved.candidate,
	});
	updateRoleFast(ctx, resolved.candidate.service_tier === "priority");
	updateRoleStatus(ctx, states.get(ctx.sessionManager));
}

async function applyRole(
	roleName: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	catalog: ModelRoleCatalog,
): Promise<ResolvedModelRole | undefined> {
	const resolved = resolveModelRole(roleName, ctx.modelRegistry, catalog);
	if (!resolved) return undefined;

	if (!ctx.model || modelKey(ctx.model) !== modelKey(resolved.model)) {
		const changed = await pi.setModel(resolved.model);
		if (changed === false) return undefined;
	}
	pi.setThinkingLevel(resolved.candidate.thinking);
	return resolved;
}

async function chooseRole(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	catalog: ModelRoleCatalog,
	scope: RoleScope,
	states: WeakMap<object, RoleState>,
): Promise<void> {
	if (!ctx.hasUI) return;
	const current = states.get(ctx.sessionManager)?.roleName ?? sessionRole(ctx) ?? selectedRole(catalog.defaultRole);
	const role = await openModelRolePicker(ctx, catalog, current);
	if (role) await selectRole(role, scope, ctx, pi, catalog, states);
}

async function selectRole(
	requestedRole: string,
	scope: RoleScope,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	catalog: ModelRoleCatalog,
	states: WeakMap<object, RoleState>,
): Promise<void> {
	if (!catalog.roles[requestedRole]) {
		ctx.ui.notify(`Unknown model role "${requestedRole}".`, "error");
		return;
	}
	try {
		const resolved = await applyRole(requestedRole, ctx, pi, catalog);
		if (!resolved) {
			ctx.ui.notify(`No usable model candidate for role "${requestedRole}".`, "error");
			return;
		}
		if (scope === "global") updateRoleSelection(scope, requestedRole);
		appendRoleSessionEntry(ctx, requestedRole);
		rememberRole(states, ctx, resolved);
		ctx.ui.notify(`Role: ${roleLabel(requestedRole, resolved)}`, "info");
	} catch (error) {
		ctx.ui.notify(
			`Failed to select role "${requestedRole}": ${error instanceof Error ? error.message : error}`,
			"error",
		);
	}
}

async function clearRole(
	scope: RoleScope,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	catalog: ModelRoleCatalog,
	states: WeakMap<object, RoleState>,
): Promise<void> {
	try {
		appendRoleSessionEntry(ctx, null);
		updateRoleSelection(scope, undefined);
		const requestedRole = catalog.defaultRole;
		const resolved = await applyRole(requestedRole, ctx, pi, catalog);
		if (!resolved) {
			ctx.ui.notify(`No usable model candidate for role "${requestedRole}".`, "error");
			return;
		}
		rememberRole(states, ctx, resolved);
		ctx.ui.notify(`Role: ${roleLabel(requestedRole, resolved)}`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to clear model role: ${error instanceof Error ? error.message : error}`, "error");
	}
}

function completions(prefix: string, catalog: ModelRoleCatalog): AutocompleteItem[] | null {
	const trimmed = prefix.trimStart();
	const global = trimmed.startsWith("--global");
	const token = global ? trimmed.slice("--global".length).trimStart() : prefix.trim();
	const values = global
		? Object.keys(catalog.roles)
		: ["--global", "clear", "edit", "setup", ...Object.keys(catalog.roles)];
	const items = values
		.filter((value) => value.startsWith(token))
		.sort()
		.map((value) => ({ value, label: value }));
	return items.length > 0 ? items : null;
}

export default function modelRolesExtension(pi: ExtensionAPI) {
	installSessionOnlySettings();
	const catalog = loadModelRoles();
	const states = new WeakMap<object, RoleState>();

	pi.on("session_start", async (event, ctx) => {
		const requestedRole =
			event.reason === "new"
				? (attachedModelRole() ?? catalog.defaultRole)
				: (sessionRole(ctx) ?? attachedModelRole() ?? selectedRole(catalog.defaultRole));
		const resolved = await applyRole(requestedRole, ctx, pi, catalog);
		if (!resolved) {
			updateRoleFast(ctx, false);
			ctx.ui.notify(`No usable model candidate for role "${requestedRole}".`, "error");
		} else rememberRole(states, ctx, resolved);
	});

	pi.on("model_select", (_event, ctx) => {
		const state = states.get(ctx.sessionManager);
		if (state && (!ctx.model || modelKey(ctx.model) !== state.modelKey)) {
			states.delete(ctx.sessionManager);
			updateRoleFast(ctx, false);
			updateRoleStatus(ctx, undefined);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const state = states.get(ctx.sessionManager);
		if (
			!ctx.model ||
			ctx.model.provider !== "openai-codex" ||
			!state?.candidate.service_tier ||
			!isRecord(event.payload)
		)
			return;
		if (event.payload.model !== ctx.model.id || "service_tier" in event.payload) return;
		return { ...event.payload, service_tier: state.candidate.service_tier };
	});

	pi.registerCommand("role", {
		description: "Select or configure model roles",
		getArgumentCompletions: (prefix: string) => completions(prefix, catalog),
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let scope: RoleScope = "project";
			if (tokens[0] === "--global") {
				scope = "global";
				tokens.shift();
			}
			if (tokens.length === 0) {
				await chooseRole(ctx, pi, catalog, scope, states);
				return;
			}
			if (tokens.length !== 1) {
				ctx.ui.notify("Usage: /role [--global] [clear|edit|NAME]", "warning");
				return;
			}
			if (tokens[0] === "edit" || tokens[0] === "setup") {
				await editModelRoles(ctx, catalog);
				return;
			}
			if (tokens[0] === "clear") {
				await clearRole(scope, ctx, pi, catalog, states);
				return;
			}
			await selectRole(tokens[0], scope, ctx, pi, catalog, states);
		},
	});

	pi.registerShortcut("alt+p", {
		description: "Select model role",
		handler: async (ctx) => chooseRole(ctx, pi, catalog, "project", states),
	});
}
