import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { TeamTask, WorkerRecord } from "./types.js";
import { buildWorkerPrompt } from "./prompts.js";
import type { TeamStore } from "./store.js";

type LiveRun = { process: ChildProcess; worker: WorkerRecord };

export type RuntimeEvent = {
	worker: WorkerRecord;
	status: "completed" | "failed" | "stopped";
	summary: string;
};

export interface TeamRuntime {
	launchWorker(worker: WorkerRecord, task?: TeamTask, message?: string): Promise<WorkerRecord>;
	resumeWorker(worker: WorkerRecord, task?: TeamTask, message?: string): Promise<WorkerRecord>;
	getWorkerStatus(worker: WorkerRecord): Promise<WorkerRecord>;
	stopWorker(worker: WorkerRecord): Promise<WorkerRecord>;
	interruptWorker(worker: WorkerRecord): Promise<WorkerRecord>;
}

export class PiSubagentRuntime implements TeamRuntime {
	private readonly live = new Map<string, LiveRun>();

	constructor(
		private readonly store: TeamStore,
		private readonly onEvent: (event: RuntimeEvent) => void,
	) {}

	async launchWorker(worker: WorkerRecord, task?: TeamTask, message?: string): Promise<WorkerRecord> {
		return this.start(worker, task, message);
	}

	async resumeWorker(worker: WorkerRecord, task?: TeamTask, message?: string): Promise<WorkerRecord> {
		return this.start(worker, task, message ?? "Continue from the last checkpoint and report progress.");
	}

	async getWorkerStatus(worker: WorkerRecord): Promise<WorkerRecord> {
		return this.live.has(worker.id) ? { ...worker, status: "running" } : worker;
	}

	async stopWorker(worker: WorkerRecord): Promise<WorkerRecord> {
		const live = this.live.get(worker.id);
		live?.process.kill("SIGTERM");
		const updated = { ...worker, status: "stopped" as const };
		await this.store.saveWorker(updated);
		return updated;
	}

	async interruptWorker(worker: WorkerRecord): Promise<WorkerRecord> {
		return this.stopWorker(worker);
	}

	private async start(worker: WorkerRecord, task?: TeamTask, message?: string): Promise<WorkerRecord> {
		if (this.live.has(worker.id)) throw new Error(`worker already running: ${worker.name}`);
		let launchWorker = worker;
		if (worker.mode === "worktree" && !worker.worktree) {
			launchWorker = await createWorkerWorktree(worker);
			await this.store.saveWorker(launchWorker);
		}
		const prompt = buildWorkerPrompt(launchWorker, task, message);
		const promptPath = await writePrompt(launchWorker.id, prompt);
		const sessionFile = launchWorker.sessionFile ?? this.store.workerSessionFile(launchWorker.id);
		await mkdir(dirname(sessionFile), { recursive: true });
		const args = ["--no-extensions", "--mode", "json", "-p", "--session", sessionFile, "--append-system-prompt", promptPath, prompt];
		const proc = spawn("pi", args, { cwd: launchWorker.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_TEAM_MODE_WORKER: "1" } });
		const updated: WorkerRecord = { ...launchWorker, status: "running", sessionFile, asyncRunId: proc.pid ? String(proc.pid) : undefined };
		await this.store.saveWorker(updated);
		this.live.set(worker.id, { process: proc, worker: updated });
		this.collect(worker.id, proc, updated);
		return updated;
	}

	private collect(workerId: string, proc: ChildProcess, worker: WorkerRecord): void {
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 32_000) stdout = stdout.slice(-32_000);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
		});
		proc.on("close", (code, signal) => {
			void this.finishRun(workerId, worker, stdout, stderr, code, signal);
		});
	}

	private async finishRun(workerId: string, worker: WorkerRecord, stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		this.live.delete(workerId);
		const failed = code !== 0 || !!signal;
		const sessionText = worker.sessionFile ? await readFile(worker.sessionFile, "utf8").catch(() => "") : "";
		const summary = extractFinalText(sessionText) || extractFinalText(stdout) || (failed ? stderr.trim() : "") || (failed ? `pi exited ${code ?? signal}` : "Worker completed.");
		const next: WorkerRecord = { ...worker, status: failed ? "failed" : "completed", lastResult: summary, lastSummary: summary.split("\n")[0], lastExitCode: code };
		await this.store.saveWorker(next);
		this.onEvent({ worker: next, status: next.status as "completed" | "failed", summary });
	}
}

async function writePrompt(workerId: string, prompt: string): Promise<string> {
	const dir = join(tmpdir(), "pi-team-mode");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${workerId}-prompt.md`);
	await writeFile(path, prompt, "utf8");
	return path;
}

async function createWorkerWorktree(worker: WorkerRecord): Promise<WorkerRecord> {
	const repoRoot = (await runGit(worker.cwd, ["rev-parse", "--show-toplevel"])).trim();
	const baseRef = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
	const suffix = randomUUID().slice(0, 8);
	const baseDir = join(tmpdir(), "pi-team-mode-worktrees");
	await mkdir(baseDir, { recursive: true });
	const path = join(baseDir, `${worker.name}-${suffix}`);
	const branch = `team-mode/${worker.name}-${suffix}`.replace(/[^A-Za-z0-9/_-]/g, "-");
	await runGit(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
	return { ...worker, cwd: path, isolation: "worktree", worktree: { path, branch, baseRef } };
}

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		proc.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed`));
		});
		proc.on("error", reject);
	});
}

type PiTextPart = { type?: string; text?: string };
type PiMessageEvent = {
	type?: string;
	text?: string;
	message?: { role?: string; content?: PiTextPart[] };
};

function extractFinalText(output: string): string | undefined {
	const lines = output.split("\n").filter(Boolean);
	for (const line of lines.reverse()) {
		try {
			const event = JSON.parse(line) as PiMessageEvent;
			const text = textFromEvent(event);
			if (text) return text;
		} catch {
			// ignore non-json output
		}
	}
	return undefined;
}

function textFromEvent(event: PiMessageEvent): string | undefined {
	if (typeof event.text === "string" && event.text.trim()) return event.text.trim();
	if (!Array.isArray(event.message?.content)) return undefined;
	if (event.message.role && event.message.role !== "assistant") return undefined;
	const text = event.message.content
		.filter((part) => part.type === "text" && part.text)
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}
