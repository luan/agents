import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type RoleScope = "project" | "global";
export type RoleSelection = {
	defaultRole?: string;
	projects?: Record<string, string>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectionPath(): string {
	return join(getAgentDir(), "model-role-selection.json");
}

export function projectKey(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}

export function loadRoleSelection(): RoleSelection {
	const path = selectionPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) return {};
		const projects = isRecord(raw.projects)
			? Object.fromEntries(
					Object.entries(raw.projects).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
					),
				)
			: undefined;
		return {
			defaultRole: typeof raw.defaultRole === "string" ? raw.defaultRole : undefined,
			projects,
		};
	} catch (error) {
		console.error(`[roles] Failed to load ${path}: ${error instanceof Error ? error.message : error}`);
		return {};
	}
}

export function selectedRole(cwd: string, defaultRole: string): string {
	const selection = loadRoleSelection();
	return selection.projects?.[projectKey(cwd)] ?? selection.defaultRole ?? defaultRole;
}

export function updateRoleSelection(scope: RoleScope, cwd: string, role: string | undefined): void {
	const selection = loadRoleSelection();
	if (scope === "global") {
		if (role) selection.defaultRole = role;
		else delete selection.defaultRole;
	} else {
		const projects = selection.projects ?? {};
		const key = projectKey(cwd);
		if (role) projects[key] = role;
		else delete projects[key];
		selection.projects = Object.keys(projects).length > 0 ? projects : undefined;
	}
	writeFileSync(selectionPath(), `${JSON.stringify(selection, null, 2)}\n`);
}
