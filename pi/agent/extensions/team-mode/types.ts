export type TeamStatus = "running" | "paused" | "completed" | "failed" | "stopped";
export type WorkerRole = "researcher" | "planner" | "implementer" | "reviewer" | "tester" | "custom";
export type WorkerMode = "advisory" | "single-writer" | "worktree";
export type WorkerStatus = "queued" | "running" | "paused" | "completed" | "failed" | "stopped";
export type TaskStatus = "pending" | "ready" | "in_progress" | "blocked" | "review" | "completed" | "failed" | "cancelled";

export type TeamRecord = {
	id: string;
	name: string;
	objective: string;
	status: TeamStatus;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	activeWorkerId?: string;
	summary?: string;
};

export type WorkerRecord = {
	id: string;
	teamId: string;
	name: string;
	role: WorkerRole;
	status: WorkerStatus;
	objective: string;
	currentTaskId?: string;
	sessionFile?: string;
	asyncRunId?: string;
	cwd: string;
	isolation: "none" | "worktree";
	mode: WorkerMode;
	worktree?: { path: string; branch: string; baseRef: string; retainedReason?: string };
	model?: string;
	createdAt: string;
	updatedAt: string;
	lastEventId?: string;
	lastSummary?: string;
	lastResult?: string;
	lastExitCode?: number | null;
};

export type TeamTask = {
	id: string;
	teamId: string;
	subject: string;
	description: string;
	status: TaskStatus;
	owner?: string;
	dependencies: string[];
	blocks: string[];
	files: string[];
	result?: string;
	version: number;
	createdAt: string;
	updatedAt: string;
};

export type TeamEvent = {
	id: string;
	teamId: string;
	type:
		| "team_started"
		| "task_created"
		| "worker_spawned"
		| "worker_progress"
		| "worker_completed"
		| "worker_failed"
		| "task_updated"
		| "attention_needed"
		| "team_paused"
		| "team_resumed"
		| "team_stopped";
	actor?: string;
	taskId?: string;
	message: string;
	details?: Record<string, unknown>;
	createdAt: string;
};

export type TeamSummary = {
	team: TeamRecord;
	workers: WorkerRecord[];
	tasks: TeamTask[];
	events: TeamEvent[];
};

export const WORKER_STATUS_ICON: Record<WorkerStatus, string> = {
	queued: "○",
	running: "⠼",
	paused: "Ⅱ",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

export const TASK_STATUS_ICON: Record<TaskStatus, string> = {
	pending: "○",
	ready: "◇",
	in_progress: "⠼",
	blocked: "◆",
	review: "◐",
	completed: "✓",
	failed: "✗",
	cancelled: "■",
};

export const TERMINAL_WORKER_STATUSES = new Set<WorkerStatus>(["completed", "failed", "stopped"]);

export const DEFAULT_ROLE_MODE: Record<WorkerRole, WorkerMode> = {
	researcher: "advisory",
	planner: "advisory",
	implementer: "single-writer",
	reviewer: "advisory",
	tester: "advisory",
	custom: "advisory",
};

export function nowIso(): string {
	return new Date().toISOString();
}

export function slugify(value: string, fallback = "team"): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || fallback;
}
