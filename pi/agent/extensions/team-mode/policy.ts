import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { WorkerMode, WorkerRole } from "./types.js";
import { DEFAULT_ROLE_MODE } from "./types.js";

const COORDINATOR_ALLOWED_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"sym_search",
	"sym_investigate",
	"sym_show",
	"sym_outline",
	"sym_refs",
	"sym_impact",
	"sym_trace",
	"sym_impls",
	"sym_context",
	"sym_structure",
	"sym_diff",
	"vault_create",
	"vault_read",
	"vault_list",
	"vault_search",
	"vault_status",
	"team_start",
	"team_spawn_worker",
	"team_send",
	"team_task_create",
	"team_task_update",
	"team_status",
	"team_control",
]);

const MUTATING_BASH = /\b(?:rm|mv|cp|chmod|chown|mkdir|touch|sed\s+-i|perl\s+-pi|git\s+(?:commit|reset|checkout|restore|clean|merge|rebase|apply|am)|npm\s+(?:install|update)|pnpm\s+(?:install|update)|bun\s+(?:add|remove))\b/;

export function defaultModeForRole(role: WorkerRole, requested?: WorkerMode): WorkerMode {
	return requested ?? DEFAULT_ROLE_MODE[role];
}

export function applyCoordinatorToolPolicy(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const next = active.filter((tool) => COORDINATOR_ALLOWED_TOOLS.has(tool) || tool.startsWith("team_"));
	for (const tool of ["team_start", "team_spawn_worker", "team_send", "team_task_create", "team_task_update", "team_status", "team_control"]) {
		if (!next.includes(tool)) next.push(tool);
	}
	if (next.length !== active.length || next.some((tool, index) => active[index] !== tool)) {
		pi.setActiveTools(next);
	}
}

export function isBlockedCoordinatorTool(event: { toolName: string; input?: unknown }): string | undefined {
	if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "apply_patch") {
		return "Team Mode coordinator is read/orchestration-only. Assign file mutations to an implementer worker.";
	}
	if (event.toolName === "bash") {
		const command = typeof (event.input as { command?: unknown } | undefined)?.command === "string" ? (event.input as { command: string }).command : "";
		if (MUTATING_BASH.test(command)) {
			return "Team Mode coordinator cannot run mutating shell commands. Assign implementation to a worker.";
		}
	}
	return undefined;
}

export async function isGitDirty(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("git", ["status", "--porcelain"], { cwd }).catch(() => ({ stdout: "", stderr: "", code: 1, killed: false }));
	return result.code === 0 && result.stdout.trim().length > 0;
}
