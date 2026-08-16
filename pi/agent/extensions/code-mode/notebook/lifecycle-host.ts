/**
 * The live seam behind the three notebook controllers.
 *
 * `NotebookSessionHost` binds one `NotebookCellKernel` to the checkpoint manager, the project state,
 * the named profiles, and the journal. It implements `NotebookLifecycleHost`, `NotebookProfileHost`,
 * and `NotebookRecoveryHost`, so lifecycle.ts, profile-lifecycle.ts, and recovery.ts keep their one
 * seam and never touch the kernel process or a state file.
 *
 * The kernel is reachable only through `NotebookCellKernel.execute` (index.ts:44), so every kernel
 * question is asked as injected source and answered on stdout.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CellOutcome } from "../rust-kernel.ts";
import {
	garbageCollectSupersededNotebookCheckpoints,
	type NotebookCheckpointIdentity,
	removeNotebookCheckpoint,
	resolveNotebookCheckpointMaxBytes,
	restoreNotebookCheckpoint,
} from "./checkpoint.ts";
import { NotebookCheckpointManager } from "./checkpoint-manager.ts";
import { restoreSource } from "./checkpoint-runtime.ts";
import { ensureDenoBinary } from "./deno-binary.ts";
import type { NotebookCodeCell } from "./diagnostics.ts";
import type { NotebookCellKernel, NotebookOptions } from "./index.ts";
import { initializeNotebookJournal, type NotebookJournal, readNotebookJournalCodeCells } from "./journal.ts";
import {
	NotebookLifecycleController,
	type NotebookLifecycleHost,
	type NotebookLifecycleMetadata,
} from "./lifecycle.ts";
import { notebookTopLevelNamesSource, parseNotebookRuntimeResult } from "./lifecycle-runtime.ts";
import { NotebookProfileController, type NotebookProfileHost } from "./profile-lifecycle.ts";
import type { NotebookProfileCapture, NotebookProfileSnapshot } from "./profile-state.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import {
	formatProjectStateNotice,
	projectStateBindingSelection,
	promoteProjectStateBindings,
	resetProjectState as resetProjectStateFiles,
	restoreProjectState,
	syncProjectStateBindings,
} from "./project-state.ts";
import {
	type NotebookExecutionResult,
	type NotebookKernelExecutor,
	type ProjectStateBaseline,
	readProjectStateCandidate,
} from "./project-state-format.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import { type RetainedProjectBinding, readRetainedProjectBindings } from "./project-state-metadata.ts";
import { projectStateCaptureSource } from "./project-state-runtime.ts";
import { NotebookRecoveryController, type NotebookRecoveryHost } from "./recovery.ts";

/** Deno's default V8 heap on 64-bit. `resolveNotebookCheckpointMaxBytes` clamps the eighth it takes. */
const KERNEL_HEAP_MIB = 4096;
/** runtime.ts numbers user cells from 1, so a lifecycle cell never collides with one. */
const LIFECYCLE_LOCAL_ID = -1;
/**
 * The id every running-cell message reports. `NotebookCellKernel` publishes `running` and nothing
 * else (index.ts:41), so the host knows a cell runs but never which one.
 */
const ACTIVE_CELL_ID = "cell";
const EMPTY_BASELINE: ProjectStateBaseline = { generation: "root", entries: [] };

export interface NotebookLifecycleOptions extends NotebookOptions {
	/**
	 * Checkpoint identity. A session restores only its own checkpoint, so it must survive a restart.
	 * The integrator passes `notebookSessionIdentity(ctx)`; a fresh id restores nothing.
	 */
	session?: string;
	agentDir?: string;
	/** The profile whose bindings diagnostics treats as known. */
	profile?: string;
	/** Checkpoint and project state notices. `showInUi` marks the ones a user must see. */
	onNotice?: (notice: string, showInUi: boolean) => void;
}

export class NotebookSessionHost implements NotebookLifecycleHost, NotebookProfileHost, NotebookRecoveryHost {
	private readonly cells: NotebookCellKernel;
	private readonly options: NotebookLifecycleOptions;
	private readonly maxBytes = resolveNotebookCheckpointMaxBytes(KERNEL_HEAP_MIB);
	private readonly checkpoints: NotebookCheckpointManager;
	private readonly sessionIdentity: NotebookCheckpointIdentity;
	private readonly executor: NotebookKernelExecutor = {
		execute: (source, options) => this.run(source, options?.signal),
		complete: () => this.topLevelNames(),
	};
	private ready: Promise<void> | undefined;
	private started = false;
	private baselineNames = new Set<string>();
	private restored = new Set<string>();
	private restoreNotice: string | undefined;
	private startedAt: number | undefined;
	private journalState: NotebookJournal | undefined;
	private loadedProfile: string | undefined;

	constructor(cells: NotebookCellKernel, options: NotebookLifecycleOptions = {}) {
		this.cells = cells;
		this.options = options;
		this.sessionIdentity = {
			project: resolveNotebookProject(options.cwd ?? process.cwd()),
			session: options.session ?? randomUUID(),
			agentDir: options.agentDir ?? getAgentDir(),
		};
		this.checkpoints = new NotebookCheckpointManager({
			maxBytes: this.maxBytes,
			currentKernel: () => this.kernel(),
			runningCellId: () => this.activeCellId(),
			reportNotice: (notice, showInUi) => this.options.onNotice?.(notice, showInUi),
		});
	}

	prepare(signal?: AbortSignal): Promise<void> {
		this.ready ??= this.start(true, signal).catch((error: unknown) => {
			this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	kernel(): NotebookKernelExecutor | undefined {
		return this.started ? this.executor : undefined;
	}

	activeCellId(): string | undefined {
		return this.cells.running ? ACTIVE_CELL_ID : undefined;
	}

	async stopActive(): Promise<string | undefined> {
		if (!this.cells.running) return undefined;
		// The kernel exposes no per-cell interrupt, so the cell dies with its kernel process.
		await this.drop();
		return ACTIVE_CELL_ID;
	}

	async liveBindings(signal?: AbortSignal): Promise<ReadonlySet<string>> {
		const names = await this.topLevelNames(signal);
		return new Set(names.filter((name) => !this.baselineNames.has(name)));
	}

	async checkpoint(excludeNames?: ReadonlySet<string>, pins?: ProjectStatePinUpdate): Promise<void> {
		await this.checkpoints.flush({
			requireIdle: true,
			force: true,
			...(excludeNames ? { excludeNames } : {}),
			...(pins ? { pins } : {}),
		});
	}

	retainedBindings(): RetainedProjectBinding[] {
		return readRetainedProjectBindings(this.sessionIdentity, this.maxBytes);
	}

	async promoteBindings(names: string[], signal?: AbortSignal): Promise<() => Promise<void>> {
		const kernel = this.requireKernel();
		const tracked = await projectStateBindingSelection(kernel, signal);
		await promoteProjectStateBindings(kernel, names);
		// The undo runs after a failed commit, whose signal may already be aborted.
		return () => syncProjectStateBindings(kernel, tracked);
	}

	markChanged(): void {
		this.checkpoints.schedule();
	}

	async restart(signal?: AbortSignal): Promise<string | undefined> {
		await this.drop();
		await this.prepare(signal);
		return this.restoreNotice;
	}

	metadata(): NotebookLifecycleMetadata {
		return {
			...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
			userCells: this.userCells(),
			checkpoint: this.checkpoints.status(),
		};
	}

	storage(): { agentDir: string; maxBytes: number } {
		return { agentDir: this.sessionIdentity.agentDir, maxBytes: this.maxBytes };
	}

	project(): string {
		return this.sessionIdentity.project;
	}

	/** Serializes the names with the project state capture, which writes a candidate manifest. */
	async capture(names: string[], signal?: AbortSignal): Promise<NotebookProfileCapture> {
		const directory = mkdtempSync(join(tmpdir(), "pi-notebook-profile-"));
		const payloadPath = join(directory, "capture.bin");
		const manifestPath = join(directory, "capture.json");
		try {
			const result = await this.run(
				projectStateCaptureSource({ candidates: names, payloadPath, manifestPath, maxBytes: this.maxBytes }),
				signal,
			);
			if (result.status !== "ok") {
				throw new Error(`Notebook profile capture failed: ${result.errorText ?? "unknown error"}`);
			}
			const candidate = readProjectStateCandidate(manifestPath, payloadPath, this.maxBytes);
			if (!candidate) throw new Error("Notebook profile capture did not produce a valid manifest");
			return { ...candidate, payload: readFileSync(payloadPath) };
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	async restore(snapshot: NotebookProfileSnapshot, signal?: AbortSignal): Promise<void> {
		const result = await this.run(restoreSource(snapshot.manifest, snapshot.payloadPath), signal);
		if (result.status !== "ok") throw new Error(result.errorText ?? "Notebook profile restore failed");
		this.loadedProfile = snapshot.manifest.name;
	}

	/** A failed load leaves half a profile bound, so the session returns to its last checkpoint. */
	async rollback(): Promise<void> {
		await this.restart();
	}

	identity(): { project: string; agentDir: string } {
		return { project: this.sessionIdentity.project, agentDir: this.sessionIdentity.agentDir };
	}

	journal(): { path: string; cells: NotebookCodeCell[] } {
		const journal = this.notebookJournal();
		return { path: journal.path, cells: readNotebookJournalCodeCells(journal.path) };
	}

	deno(signal?: AbortSignal): Promise<string> {
		return this.options.denoPath ? Promise.resolve(this.options.denoPath) : ensureDenoBinary(signal);
	}

	restoredBindings(): ReadonlySet<string> {
		return this.restored;
	}

	profileActive(): boolean {
		return this.options.profile !== undefined && this.loadedProfile === this.options.profile;
	}

	stopWithoutCheckpoint(): Promise<string | undefined> {
		return this.stopActive();
	}

	resetProjectState(): Promise<{ generation: string; previousBindings: number }> {
		return resetProjectStateFiles(this.sessionIdentity);
	}

	removeCheckpoint(): void {
		removeNotebookCheckpoint(this.sessionIdentity);
	}

	/** Starts a kernel that restores nothing. Reset has just discarded the state it would restore. */
	async startClean(signal?: AbortSignal): Promise<void> {
		await this.drop();
		this.ready = this.start(false, signal).catch((error: unknown) => {
			this.ready = undefined;
			throw error;
		});
		await this.ready;
	}

	async checkpointEmpty(): Promise<void> {
		await this.checkpoints.flush({ force: true });
	}

	private async start(restore: boolean, signal?: AbortSignal): Promise<void> {
		// The first cell starts the kernel process and runs the bootstrap (session.ts:56).
		const started = await this.run("undefined;", signal);
		if (started.status !== "ok") throw new Error(started.errorText ?? "Notebook kernel did not start");
		this.started = true;
		this.startedAt = Date.now();
		// Taken before any restore, so a restored binding counts as a user binding, not as baseline.
		this.baselineNames = new Set(await this.topLevelNames(signal));
		this.restored = new Set();
		this.restoreNotice = undefined;
		this.checkpoints.reset();
		if (!restore) {
			this.checkpoints.configure(this.sessionIdentity, this.baselineNames, EMPTY_BASELINE);
			return;
		}
		const project = await restoreProjectState(this.executor, {
			project: this.sessionIdentity.project,
			agentDir: this.sessionIdentity.agentDir,
			maxBytes: this.maxBytes,
			...(signal ? { signal } : {}),
		});
		const session = await restoreNotebookCheckpoint(
			this.executor,
			this.sessionIdentity,
			this.maxBytes,
			project.baseline,
			signal,
		);
		this.checkpoints.configure(this.sessionIdentity, this.baselineNames, project.baseline);
		garbageCollectSupersededNotebookCheckpoints(this.sessionIdentity);
		for (const entry of project.restored) this.restored.add(entry.name);
		for (const name of session.restored) this.restored.add(name);
		this.restoreNotice =
			[
				formatProjectStateNotice(project),
				session.message,
				session.restored.length > 0
					? `Notebook session restored ${session.restored.length} binding${session.restored.length === 1 ? "" : "s"}`
					: undefined,
			]
				.filter((notice) => notice !== undefined)
				.join(". ") || undefined;
	}

	/** Drops the kernel process and everything scheduled against it. The next `prepare` builds one. */
	private async drop(): Promise<void> {
		await this.checkpoints.discard();
		this.cells.reset();
		this.started = false;
		this.ready = undefined;
	}

	private async run(source: string, signal?: AbortSignal): Promise<NotebookExecutionResult> {
		const outcome: CellOutcome = await this.cells.execute(LIFECYCLE_LOCAL_ID, source, [], signal);
		return {
			status: outcome.error ? "error" : "ok",
			...(outcome.error ? { errorText: outcome.error } : {}),
			output: outcome.output,
		};
	}

	private async topLevelNames(signal?: AbortSignal): Promise<string[]> {
		const marker = `__PI_NOTEBOOK_NAMES_${randomUUID()}__`;
		const properties = parseNotebookRuntimeResult<string[]>(
			await this.run(notebookTopLevelNamesSource(marker), signal),
			marker,
		);
		// `getOwnPropertyNames` cannot see a top-level `let` or `const`; they live in the global lexical
		// scope. Jupyter's `complete_request` reports them, so an empty-prefix completion fills the gap.
		const lexical = await this.cells.complete("", 0, signal).catch(() => [] as string[]);
		return [...new Set([...properties, ...lexical])];
	}

	private requireKernel(): NotebookKernelExecutor {
		const kernel = this.kernel();
		if (!kernel) throw new Error("Notebook kernel is not running");
		return kernel;
	}

	private notebookJournal(): NotebookJournal {
		this.journalState ??= initializeNotebookJournal(this.sessionIdentity, this.maxBytes);
		return this.journalState;
	}

	private userCells(): number {
		try {
			return this.notebookJournal().completedCells;
		} catch {
			return 0;
		}
	}
}

/** Assembles the twelve actions against one live kernel. */
export function createNotebookLifecycle(
	cells: NotebookCellKernel,
	options: NotebookLifecycleOptions = {},
): NotebookLifecycleController {
	const host = new NotebookSessionHost(cells, options);
	return new NotebookLifecycleController(
		host,
		new NotebookProfileController(host),
		new NotebookRecoveryController(
			{ maxBytes: host.storage().maxBytes, ...(options.profile ? { profile: options.profile } : {}) },
			host,
		),
	);
}
