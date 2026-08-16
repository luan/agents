import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type RoleScope = "project" | "global";
export type RoleSelection = {
	defaultRole?: string;
};

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectionPath(): string {
	return join(getAgentDir(), "model-role-selection.json");
}

export function loadRoleSelection(): RoleSelection {
	const path = selectionPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) return {};
		return {
			defaultRole: typeof raw.defaultRole === "string" ? raw.defaultRole : undefined,
		};
	} catch (error) {
		console.error(`[roles] Failed to load ${path}: ${error instanceof Error ? error.message : error}`);
		return {};
	}
}

export function selectedRole(defaultRole: string): string {
	return loadRoleSelection().defaultRole ?? defaultRole;
}

export function updateRoleSelection(scope: RoleScope, role: string | undefined): void {
	if (scope !== "global") return;
	const selection = loadRoleSelection();
	if (role) selection.defaultRole = role;
	else delete selection.defaultRole;
	writeFileSync(selectionPath(), `${JSON.stringify(selection, null, 2)}\n`);
}
