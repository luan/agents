import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { applyCoordinatorToolPolicy, defaultModeForRole, isBlockedCoordinatorTool, isGitDirty } from "./policy.js";
import { COORDINATOR_PROMPT, formatTeamNotification } from "./prompts.js";
import { PiSubagentRuntime } from "./runtime.js";
import { TeamStore, VersionConflictError, type TaskPatch } from "./store.js";
import { renderCompactWidget, TeamDashboard, type TeamDashboardAction } from "./tui.js";
import type { TeamEvent, TeamRecord, TeamSummary, TeamTask, WorkerRecord, WorkerMode, WorkerRole } from "./types.js";

const WorkerRoleSchema = StringEnum(["researcher", "planner", "implementer", "reviewer", "tester", "custom"] as const);
const WorkerModeSchema = StringEnum(["advisory", "single-writer", "worktree"] as const);
const StatusScopeSchema = StringEnum(["summary", "workers", "tasks", "events"] as const);
const ControlActionSchema = StringEnum(["pause", "resume", "stop"] as const);

const TeamStartParams = Type.Object({
	objective: Type.String(),
	template: Type.Optional(StringEnum(["research", "plan", "implement", "review", "custom"] as const)),
});

const TeamSpawnWorkerParams = Type.Object({
	name: Type.String(),
	role: WorkerRoleSchema,
	task: Type.String(),
	files: Type.Optional(Type.Array(Type.String())),
	mode: Type.Optional(WorkerModeSchema),
});

const TeamSendParams = Type.Object({ name: Type.String(), message: Type.String() });
const TeamTaskCreateParams = Type.Object({
	subject: Type.String(),
	description: Type.String(),
	dependencies: Type.Optional(Type.Array(Type.String())),
	files: Type.Optional(Type.Array(Type.String())),
});
const TeamTaskUpdateParams = Type.Object({
	id: Type.String(),
	expectedVersion: Type.Number(),
	status: Type.Optional(StringEnum(["pending", "ready", "in_progress", "blocked", "review", "completed", "failed", "cancelled"] as const)),
	owner: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.String())),
});
const TeamStatusParams = Type.Object({ scope: Type.Optional(StatusScopeSchema) });
const TeamControlParams = Type.Object({ action: ControlActionSchema, target: Type.Optional(Type.String()) });

const WIDGET_ID = "team-mode";

type RuntimeState = {
	store: TeamStore;
	runtime: PiSubagentRuntime;
	activeTeamId?: string;
	coordinatorMode: boolean;
};

export default function teamModeExtension(pi: ExtensionAPI) {
	const state: RuntimeState = {
		store: new TeamStore(),
		coordinatorMode: false,
		runtime: undefined as unknown as PiSubagentRuntime,
	};

	state.runtime = new PiSubagentRuntime(state.store, (event) => {
		void handleRuntimeEvent(pi, state, event.worker.teamId, event.worker, event.status, event.summary);
	});

	async function activeTeam(ctx: ExtensionContext): Promise<TeamRecord> {
		const team = state.activeTeamId ? await state.store.loadTeam(state.activeTeamId) : await state.store.latestActiveTeam();
		if (!team) throw new Error("No active team. Use /team start <objective> first.");
		state.activeTeamId = team.id;
		await updateWidget(ctx, state, team.id);
		return team;
	}

	async function createOrGetTask(teamId: string, subject: string, description: string, files?: string[]): Promise<TeamTask> {
		return state.store.createTask(teamId, { subject, description, files });
	}

	async function spawnWorker(ctx: ExtensionContext, params: { name: string; role: WorkerRole; task: string; files?: string[]; mode?: WorkerMode }): Promise<WorkerRecord> {
		const team = await activeTeam(ctx);
		const mode = defaultModeForRole(params.role, params.mode);
		if (mode === "worktree" && await isGitDirty(pi, team.cwd)) {
			throw new Error("Cannot spawn worktree worker from a dirty checkout. Commit/stash changes or use single-writer mode.");
		}
		const task = await createOrGetTask(team.id, params.task, params.task, params.files);
		const worker = await state.store.createWorker({
			teamId: team.id,
			name: params.name,
			role: params.role,
			objective: team.objective,
			cwd: team.cwd,
			mode,
			isolation: mode === "worktree" ? "worktree" : "none",
			currentTaskId: task.id,
		});
		const launched = await state.runtime.launchWorker(worker, task);
		await state.store.appendEvent(team.id, { type: "worker_spawned", actor: launched.name, taskId: task.id, message: `${launched.name} started ${task.subject}` });
		await updateWidget(ctx, state, team.id);
		return launched;
	}

	pi.registerTool({
		name: "team_start",
		label: "Team Start",
		description: "Create a durable Team Mode run for an objective.",
		promptSnippet: "Create a named durable team run",
		promptGuidelines: ["Use team_start before spawning named workers for long-running team orchestration."],
		parameters: TeamStartParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const params = raw as { objective: string };
			const team = await state.store.createTeam(params.objective, ctx.cwd);
			state.activeTeamId = team.id;
			state.coordinatorMode = true;
			applyCoordinatorToolPolicy(pi);
			await updateWidget(ctx, state, team.id);
			return textResult(`Team started: ${team.name} (${team.id})`, { team });
		},
	} as any);

	pi.registerTool({
		name: "team_spawn_worker",
		label: "Spawn Team Worker",
		description: "Spawn a named background worker. Returns immediately; completion arrives as a team notification.",
		promptSnippet: "Spawn a named background team worker",
		promptGuidelines: ["Workers must receive self-contained tasks. Do not predict worker results."],
		parameters: TeamSpawnWorkerParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const worker = await spawnWorker(ctx, raw as { name: string; role: WorkerRole; task: string; files?: string[]; mode?: WorkerMode });
			return textResult(`Worker spawned: ${worker.name} (${worker.id})`, { worker });
		},
	} as any);

	pi.registerTool({
		name: "team_send",
		label: "Message Team Worker",
		description: "Resume/message a named worker with a self-contained follow-up.",
		parameters: TeamSendParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const params = raw as { name: string; message: string };
			const team = await activeTeam(ctx);
			const worker = await state.store.loadWorker(team.id, params.name);
			if (!worker) throw new Error(`Unknown worker: ${params.name}`);
			const task = worker.currentTaskId ? (await state.store.listTasks(team.id)).find((item) => item.id === worker.currentTaskId) : undefined;
			const updated = await state.runtime.resumeWorker(worker, task, params.message);
			await updateWidget(ctx, state, team.id);
			return textResult(`Message sent to ${updated.name}.`, { worker: updated });
		},
	} as any);

	pi.registerTool({
		name: "team_task_create",
		label: "Create Team Task",
		description: "Create a durable versioned team task.",
		parameters: TeamTaskCreateParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const params = raw as { subject: string; description: string; dependencies?: string[]; files?: string[] };
			const team = await activeTeam(ctx);
			const task = await state.store.createTask(team.id, params);
			await updateWidget(ctx, state, team.id);
			return textResult(`Task created: ${task.id} v${task.version}`, { task });
		},
	} as any);

	pi.registerTool({
		name: "team_task_update",
		label: "Update Team Task",
		description: "Update a durable team task. Requires expectedVersion for CAS safety.",
		parameters: TeamTaskUpdateParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const params = raw as { id: string; expectedVersion: number } & TaskPatch;
			const team = await activeTeam(ctx);
			try {
				const task = await state.store.updateTask(team.id, params.id, params, params.expectedVersion);
				await updateWidget(ctx, state, team.id);
				return textResult(`Task updated: ${task.id} v${task.version}`, { task });
			} catch (error) {
				if (error instanceof VersionConflictError) {
					return textResult(`Version conflict: task is v${error.actual}, retry with a fresh team_status.`, { conflict: true, actual: error.actual });
				}
				throw error;
			}
		},
	} as any);

	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description: "Get current team summary, workers, tasks, or events.",
		parameters: TeamStatusParams,
		async execute(_id, _raw, _signal, _update, ctx) {
			const team = await activeTeam(ctx);
			const summary = await state.store.summary(team.id);
			return textResult(formatStatus(summary), summary ?? {});
		},
	} as any);

	pi.registerTool({
		name: "team_control",
		label: "Team Control",
		description: "Pause, resume, or stop the team or one worker.",
		parameters: TeamControlParams,
		async execute(_id, raw, _signal, _update, ctx) {
			const params = raw as { action: "pause" | "resume" | "stop"; target?: string };
			const team = await activeTeam(ctx);
			await controlTeam(state, team, params.action, params.target);
			await updateWidget(ctx, state, team.id);
			return textResult(`Team control: ${params.action}${params.target ? ` ${params.target}` : ""}`);
		},
	} as any);

	pi.registerCommand("team", {
		description: "Open Team Mode dashboard or run /team start|status|worker|tasks|pause|resume|stop|clear",
		handler: async (args, ctx) => {
			const [sub = "dashboard", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "start") {
				const objective = rest.join(" ").trim();
				if (!objective) return ctx.ui.notify("Usage: /team start <objective>", "warning");
				const team = await state.store.createTeam(objective, ctx.cwd);
				state.activeTeamId = team.id;
				state.coordinatorMode = true;
				applyCoordinatorToolPolicy(pi);
				await updateWidget(ctx, state, team.id);
				return ctx.ui.notify(`Team started: ${team.name}`, "info");
			}
			if (sub === "status") return ctx.ui.notify(formatStatus(await state.store.summary((await activeTeam(ctx)).id)), "info");
			if (sub === "tasks") return ctx.ui.notify(formatTasks((await state.store.summary((await activeTeam(ctx)).id))?.tasks ?? []), "info");
			if (sub === "pause" || sub === "resume" || sub === "stop") {
				const team = await activeTeam(ctx);
				await controlTeam(state, team, sub, rest[0]);
				await updateWidget(ctx, state, team.id);
				return ctx.ui.notify(`Team ${sub}.`, "info");
			}
			if (sub === "clear") return clearCurrentTeam(ctx, state);
			return openDashboard(ctx, state);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const team = await state.store.latestActiveTeam();
		if (!team) return;
		state.activeTeamId = team.id;
		await state.store.reconcileRunningWorkers(team.id);
		await updateWidget(ctx, state, team.id);
	});

	pi.on("before_agent_start", (event) => {
		if (!state.coordinatorMode) return undefined;
		applyCoordinatorToolPolicy(pi);
		return { systemPrompt: `${event.systemPrompt}\n\n${COORDINATOR_PROMPT}` };
	});

	pi.on("tool_call", (event) => {
		if (!state.coordinatorMode) return undefined;
		const reason = isBlockedCoordinatorTool(event);
		if (reason) return { block: true, reason };
		return undefined;
	});

	pi.on("session_shutdown", () => {
		state.coordinatorMode = false;
	});
}

async function handleRuntimeEvent(pi: ExtensionAPI, state: RuntimeState, teamId: string, worker: WorkerRecord, status: "completed" | "failed" | "stopped", summary: string): Promise<void> {
	const eventType = status === "completed" ? "worker_completed" : "worker_failed";
	const event = await state.store.appendEvent(teamId, { type: eventType, actor: worker.name, taskId: worker.currentTaskId, message: summary });
	sendTeamNotification(pi, event, worker);
}

function sendTeamNotification(pi: ExtensionAPI, event: TeamEvent, worker?: WorkerRecord): void {
	pi.sendMessage({
		customType: "team-notification",
		content: formatTeamNotification({ teamId: event.teamId, worker: worker?.name ?? event.actor, taskId: event.taskId, status: event.type, summary: event.message }),
		display: true,
		details: { event, worker },
	}, { triggerTurn: event.type === "worker_completed" || event.type === "worker_failed" || event.type === "attention_needed" });
}

async function controlTeam(state: RuntimeState, team: TeamRecord, action: "pause" | "resume" | "stop", target?: string): Promise<void> {
	if (target) {
		const worker = await state.store.loadWorker(team.id, target);
		if (!worker) throw new Error(`Unknown worker: ${target}`);
		await state.runtime.stopWorker(worker);
		await state.store.appendEvent(team.id, { type: "team_stopped", actor: worker.name, message: `${worker.name} stopped` });
		return;
	}
	team.status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
	await state.store.saveTeam(team);
	await state.store.appendEvent(team.id, { type: action === "pause" ? "team_paused" : action === "resume" ? "team_resumed" : "team_stopped", message: `Team ${action}` });
}

async function updateWidget(ctx: ExtensionContext, state: RuntimeState, teamId: string): Promise<void> {
	if (!ctx.hasUI) return;
	const summary = await state.store.summary(teamId);
	if (!summary) return ctx.ui.setWidget(WIDGET_ID, undefined);
	ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
		render: (width: number) => renderCompactWidget(summary, theme, width),
		invalidate() {},
	}), { placement: "belowEditor" });
}

async function openDashboard(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
	const team = await activeOrLatest(state);
	let summary = await state.store.summary(team.id);
	if (!summary) return ctx.ui.notify("No team summary available.", "warning");
	let dashboard: TeamDashboard;
	await ctx.ui.custom<null>((tui, theme, _kb, done) => {
		dashboard = new TeamDashboard(summary!, theme, (action) => {
			void handleDashboardAction(ctx, state, action, done).then(async () => {
				summary = await state.store.summary(team.id);
				if (summary) dashboard.setSummary(summary);
				tui.requestRender();
			});
		});
		return dashboard;
	}, { overlay: true, overlayOptions: { anchor: "right-center", width: "70%", minWidth: 72, margin: 1 } });
}

async function handleDashboardAction(ctx: ExtensionContext, state: RuntimeState, action: TeamDashboardAction, done: (value: null) => void): Promise<void> {
	if (action.type === "close") return done(null);
	const team = await activeOrLatest(state);
	if (action.type === "message") {
		const message = await ctx.ui.editor(`Message ${action.worker.name}`, "");
		if (message?.trim()) await state.runtime.resumeWorker(action.worker, undefined, message.trim());
	}
	if (action.type === "togglePause") await controlTeam(state, team, team.status === "paused" ? "resume" : "pause");
	if (action.type === "stop") await controlTeam(state, team, "stop", action.worker?.name);
	if (action.type === "openPath") ctx.ui.setEditorText(action.path);
}

async function activeOrLatest(state: RuntimeState): Promise<TeamRecord> {
	const team = state.activeTeamId ? await state.store.loadTeam(state.activeTeamId) : await state.store.latestActiveTeam();
	if (!team) throw new Error("No active team.");
	state.activeTeamId = team.id;
	return team;
}

async function clearCurrentTeam(ctx: ExtensionContext, state: RuntimeState): Promise<void> {
	const team = await activeOrLatest(state);
	const activeWorkers = (await state.store.listWorkers(team.id)).filter((worker) => worker.status === "running" || worker.status === "queued");
	if (activeWorkers.length > 0) return ctx.ui.notify("Cannot clear a team with active workers. Stop them first.", "warning");
	const ok = await ctx.ui.confirm("Clear team?", `Delete durable state for ${team.name}?`);
	if (!ok) return;
	await state.store.clearTeam(team.id);
	state.activeTeamId = undefined;
	ctx.ui.setWidget(WIDGET_ID, undefined);
	ctx.ui.notify(`Cleared ${team.name}.`, "info");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatStatus(summary: TeamSummary | null): string {
	if (!summary) return "No active team.";
	const done = summary.tasks.filter((task) => task.status === "completed").length;
	const running = summary.workers.filter((worker) => worker.status === "running").length;
	return [
		`Team ${summary.team.name} (${summary.team.status})`,
		`Objective: ${summary.team.objective}`,
		`Workers: ${summary.workers.length} total, ${running} running`,
		`Tasks: ${done}/${summary.tasks.length} completed`,
		"",
		formatTasks(summary.tasks),
	].join("\n");
}

function formatTasks(tasks: TeamTask[]): string {
	if (tasks.length === 0) return "No tasks.";
	return tasks.map((task) => `• ${task.id} v${task.version} [${task.status}] ${task.subject}${task.owner ? ` — ${task.owner}` : ""}`).join("\n");
}
