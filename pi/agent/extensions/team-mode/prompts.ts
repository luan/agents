import type { TeamTask, WorkerRecord } from "./types.js";

export const COORDINATOR_PROMPT = `
# Team Mode Coordinator

You are coordinating a named team of background workers. Your job is to decompose work, launch workers, synthesize their outputs, and communicate clear progress to the user.

Rules:
- Launch independent read-only research in parallel when useful.
- Do not claim worker results before a <team-notification> arrives.
- Worker prompts must be self-contained; workers do not see the parent conversation.
- Synthesize worker findings yourself before assigning follow-up implementation.
- Prefer one writer at a time in the shared checkout. Use worktree mode only for independent write tasks.
- Use team_task_update with the latest expectedVersion from team_status/team_task_create output.

Team Mode notifications are custom extension messages, not human user messages. Treat <team-notification> as internal coordination state and summarize it for the user only when useful.
`;

export function buildWorkerPrompt(worker: WorkerRecord, task: TeamTask | undefined, message?: string): string {
	const files = task?.files?.length ? task.files.map((file) => `- ${file}`).join("\n") : "(none specified)";
	return [
		`# Team Worker: ${worker.name}`,
		`Role: ${worker.role}`,
		`Mode: ${worker.mode}`,
		`Objective: ${worker.objective}`,
		"",
		task
			? [
					"## Current Task",
					`ID: ${task.id}`,
					`Subject: ${task.subject}`,
					task.description,
					"",
					"Files:",
					files,
				].join("\n")
			: "## Current Task\nNo explicit task record was attached. Follow the message below.",
		"",
		message ? `## Coordinator Message\n${message}` : "",
		"",
		"## Operating Rules",
		"- Keep work focused on your assigned task.",
		"- If you need a decision, say BLOCKED and explain the exact decision needed.",
		"- If you modify files, use apply_patch and report every changed path.",
		"- Finish with: Summary, Files, Verification, Blockers.",
	]
		.filter(Boolean)
		.join("\n");
}

export function formatTeamNotification(input: {
	teamId: string;
	worker?: string;
	taskId?: string;
	status: string;
	summary: string;
}): string {
	const lines = ["<team-notification>", `  <team-id>${escapeXml(input.teamId)}</team-id>`];
	if (input.worker) lines.push(`  <worker>${escapeXml(input.worker)}</worker>`);
	if (input.taskId) lines.push(`  <task-id>${escapeXml(input.taskId)}</task-id>`);
	lines.push(`  <status>${escapeXml(input.status)}</status>`);
	lines.push(`  <summary>${escapeXml(input.summary)}</summary>`);
	lines.push("</team-notification>");
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
