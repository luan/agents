import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { TeamEvent, TeamRecord, TeamSummary, TeamTask, WorkerRecord, WorkerRole } from "./types.js";
import { nowIso, slugify, TERMINAL_WORKER_STATUSES } from "./types.js";

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;
const LOCK_MAX_ATTEMPTS = 150;

export class VersionConflictError extends Error {
	constructor(
		public readonly actual: number,
		public readonly expected: number,
	) {
		super(`version conflict: expected ${expected}, got ${actual}`);
		this.name = "VersionConflictError";
	}
}

export function getTeamModeRoot(): string {
	return process.env.PI_TEAM_MODE_ROOT || join(homedir(), ".pi", "agent", "team-mode");
}

export function teamIdFromObjective(objective: string): string {
	return `team-${slugify(objective)}-${randomUUID().slice(0, 8)}`;
}

export function workerIdFromName(name: string): string {
	return `worker-${slugify(name, "worker")}-${randomUUID().slice(0, 8)}`;
}

export function taskIdFromSubject(subject: string): string {
	return `task-${slugify(subject, "task")}-${randomUUID().slice(0, 8)}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

async function listJson<T>(dir: string): Promise<T[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files = entries.filter((entry) => entry.endsWith(".json"));
	const items = await Promise.all(files.map((file) => readJson<T>(join(dir, file))));
	return items.filter((item) => item !== null) as T[];
}

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStaleLock(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > LOCK_STALE_MS;
	} catch {
		return false;
	}
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			try {
				return await fn();
			} finally {
				await unlink(lockPath).catch(() => {});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await isStaleLock(lockPath)) {
				await unlink(lockPath).catch(() => {});
				continue;
			}
			await delay(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
		}
	}
	throw new Error(`could not acquire lock: ${lockPath}`);
}

export type CreateTaskInput = {
	subject: string;
	description: string;
	dependencies?: string[];
	files?: string[];
	owner?: string;
};

export type TaskPatch = Partial<Pick<TeamTask, "subject" | "description" | "status" | "owner" | "files" | "result">> & {
	dependencies?: string[];
	blocks?: string[];
};

export class TeamStore {
	constructor(private readonly root = getTeamModeRoot()) {}

	teamDir(teamId: string): string {
		return join(this.root, "teams", teamId);
	}

	teamFile(teamId: string): string {
		return join(this.teamDir(teamId), "team.json");
	}

	workersDir(teamId: string): string {
		return join(this.teamDir(teamId), "workers");
	}

	tasksDir(teamId: string): string {
		return join(this.teamDir(teamId), "tasks");
	}

	eventsFile(teamId: string): string {
		return join(this.teamDir(teamId), "events.ndjson");
	}

	sessionsDir(): string {
		return join(this.root, "sessions");
	}

	workerSessionFile(workerId: string): string {
		return join(this.sessionsDir(), `${workerId}.jsonl`);
	}

	private workerFile(teamId: string, workerId: string): string {
		return join(this.workersDir(teamId), `${workerId}.json`);
	}

	private taskFile(teamId: string, taskId: string): string {
		return join(this.tasksDir(teamId), `${taskId}.json`);
	}

	private teamLock(teamId: string, name: string): string {
		return join(this.teamDir(teamId), `${name}.lock`);
	}

	async createTeam(objective: string, cwd: string): Promise<TeamRecord> {
		const now = nowIso();
		const team: TeamRecord = {
			id: teamIdFromObjective(objective),
			name: slugify(objective),
			objective,
			status: "running",
			cwd,
			createdAt: now,
			updatedAt: now,
		};
		await writeJsonAtomic(this.teamFile(team.id), team);
		await mkdir(this.workersDir(team.id), { recursive: true });
		await mkdir(this.tasksDir(team.id), { recursive: true });
		await mkdir(this.sessionsDir(), { recursive: true });
		await this.appendEvent(team.id, {
			type: "team_started",
			message: `Team started: ${objective}`,
		});
		return team;
	}

	async saveTeam(team: TeamRecord): Promise<void> {
		await writeJsonAtomic(this.teamFile(team.id), {
			...team,
			updatedAt: nowIso(),
		});
	}

	async loadTeam(teamId: string): Promise<TeamRecord | null> {
		return readJson<TeamRecord>(this.teamFile(teamId));
	}

	async listTeams(): Promise<TeamRecord[]> {
		const dir = join(this.root, "teams");
		let ids: string[];
		try {
			ids = await readdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const teams = await Promise.all(ids.map((id) => this.loadTeam(id)));
		return teams
			.filter((team): team is TeamRecord => team !== null)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async latestActiveTeam(): Promise<TeamRecord | null> {
		return (await this.listTeams()).find((team) => team.status === "running" || team.status === "paused") ?? null;
	}

	async createWorker(input: {
		teamId: string;
		name: string;
		role: WorkerRole;
		objective: string;
		cwd: string;
		mode: WorkerRecord["mode"];
		isolation: WorkerRecord["isolation"];
		currentTaskId?: string;
	}): Promise<WorkerRecord> {
		return withLock(this.teamLock(input.teamId, "workers"), async () => {
			const existing = await this.listWorkers(input.teamId);
			if (existing.some((worker) => worker.name === input.name && !TERMINAL_WORKER_STATUSES.has(worker.status))) {
				throw new Error(`worker already exists: ${input.name}`);
			}
			const now = nowIso();
			const worker: WorkerRecord = {
				id: workerIdFromName(input.name),
				teamId: input.teamId,
				name: input.name,
				role: input.role,
				status: "queued",
				objective: input.objective,
				currentTaskId: input.currentTaskId,
				cwd: input.cwd,
				mode: input.mode,
				isolation: input.isolation,
				createdAt: now,
				updatedAt: now,
			};
			worker.sessionFile = this.workerSessionFile(worker.id);
			await this.saveWorker(worker);
			return worker;
		});
	}

	async saveWorker(worker: WorkerRecord): Promise<void> {
		await writeJsonAtomic(this.workerFile(worker.teamId, worker.id), {
			...worker,
			updatedAt: nowIso(),
		});
	}

	async loadWorker(teamId: string, workerIdOrName: string): Promise<WorkerRecord | null> {
		const direct = await readJson<WorkerRecord>(this.workerFile(teamId, workerIdOrName));
		if (direct) return direct;
		return (await this.listWorkers(teamId)).find((worker) => worker.name === workerIdOrName) ?? null;
	}

	async listWorkers(teamId: string): Promise<WorkerRecord[]> {
		return listJson<WorkerRecord>(this.workersDir(teamId));
	}

	async createTask(teamId: string, input: CreateTaskInput): Promise<TeamTask> {
		const now = nowIso();
		const task: TeamTask = {
			id: taskIdFromSubject(input.subject),
			teamId,
			subject: input.subject,
			description: input.description,
			status: input.dependencies?.length ? "pending" : "ready",
			owner: input.owner,
			dependencies: input.dependencies ?? [],
			blocks: [],
			files: input.files ?? [],
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		await writeJsonAtomic(this.taskFile(teamId, task.id), task);
		await this.appendEvent(teamId, {
			type: "task_created",
			taskId: task.id,
			message: `Task created: ${task.subject}`,
		});
		return task;
	}

	async updateTask(teamId: string, taskId: string, patch: TaskPatch, expectedVersion: number): Promise<TeamTask> {
		return withLock(this.teamLock(teamId, `task-${taskId}`), async () => {
			const current = await readJson<TeamTask>(this.taskFile(teamId, taskId));
			if (!current) throw new Error(`unknown task: ${taskId}`);
			if (current.version !== expectedVersion) throw new VersionConflictError(current.version, expectedVersion);
			const updated: TeamTask = {
				...current,
				...patch,
				dependencies: patch.dependencies ?? current.dependencies,
				blocks: patch.blocks ?? current.blocks,
				files: patch.files ?? current.files,
				updatedAt: nowIso(),
				version: current.version + 1,
			};
			await writeJsonAtomic(this.taskFile(teamId, taskId), updated);
			await this.appendEvent(teamId, {
				type: "task_updated",
				taskId,
				message: `Task updated: ${updated.subject}`,
			});
			return updated;
		});
	}

	async listTasks(teamId: string): Promise<TeamTask[]> {
		return listJson<TeamTask>(this.tasksDir(teamId));
	}

	async appendEvent(teamId: string, input: Omit<TeamEvent, "id" | "teamId" | "createdAt">): Promise<TeamEvent> {
		await mkdir(this.teamDir(teamId), { recursive: true });
		const event: TeamEvent = {
			id: `event-${Date.now()}-${randomUUID().slice(0, 8)}`,
			teamId,
			createdAt: nowIso(),
			...input,
		};
		const handle = await open(this.eventsFile(teamId), "a");
		try {
			await handle.write(`${JSON.stringify(event)}\n`);
		} finally {
			await handle.close();
		}
		return event;
	}

	async listEvents(teamId: string, limit = 100): Promise<TeamEvent[]> {
		try {
			const lines = (await readFile(this.eventsFile(teamId), "utf8")).split("\n").filter(Boolean);
			return lines.slice(-limit).map((line) => JSON.parse(line) as TeamEvent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	async summary(teamId: string): Promise<TeamSummary | null> {
		const team = await this.loadTeam(teamId);
		if (!team) return null;
		return {
			team,
			workers: await this.listWorkers(teamId),
			tasks: await this.listTasks(teamId),
			events: await this.listEvents(teamId),
		};
	}

	async clearTeam(teamId: string): Promise<void> {
		if (await exists(this.teamDir(teamId))) await rm(this.teamDir(teamId), { recursive: true, force: true });
	}

	async reconcileRunningWorkers(teamId: string): Promise<void> {
		const workers = await this.listWorkers(teamId);
		for (const worker of workers) {
			if (worker.status !== "running") continue;
			worker.status = "stopped";
			worker.lastSummary = "Marked stopped during startup recovery; live process is not attached.";
			await this.saveWorker(worker);
			await this.appendEvent(teamId, {
				type: "worker_failed",
				actor: worker.name,
				taskId: worker.currentTaskId,
				message: `${worker.name} marked stopped during startup recovery`,
				details: { reason: "orphaned-runtime" },
			});
		}
	}
}
