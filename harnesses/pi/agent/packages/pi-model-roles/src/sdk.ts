import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLE_SELECTION_ENTRY, type ModelRoleSelectionData } from "./runtime/selection.ts";

export { getModelRoleCatalog } from "./config/settings.ts";
export {
	DEFAULT_MODEL_ROLE_CATALOG,
	type ModelRole,
	type ModelRoleCatalog,
	type ResolvedModelRole,
	type RoleCandidate,
	resolveModelRole,
} from "./core/catalog.ts";

/**
 * Seed a newly created child session before its extensions bind.
 *
 * The role remains session-local and is restored by pi-model-roles when the
 * child runtime starts. The caller owns choosing a role from its active
 * catalogue.
 */
export function seedChildModelRole(sessionManager: Pick<SessionManager, "appendCustomEntry">, role: string): string {
	const selection: ModelRoleSelectionData = { version: 1, role };
	return sessionManager.appendCustomEntry(MODEL_ROLE_SELECTION_ENTRY, selection);
}
