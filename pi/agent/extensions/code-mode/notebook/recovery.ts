/**
 * The two host-side repair actions: diagnostics and destructive reset.
 *
 * Kernel and session mechanics stay behind `NotebookRecoveryHost`. This module only orders the
 * steps and reports them, so it never touches the journal, checkpoint, or project state files.
 *
 * Reset discards live and project state, and the npm inventory with it: an unlisted package must
 * need approval again after a reset. Saved notebooks and named profiles survive.
 */

import { diagnoseNotebook, type NotebookCodeCell } from "./diagnostics.ts";
import { resetNotebookNpmImports } from "./npm-imports.ts";
import { notebookProfileBindingNames } from "./profile-state.ts";

export interface NotebookRecoveryResult {
	message: string;
	details: Record<string, unknown>;
}

export interface NotebookRecoveryHost {
	identity(): { project: string; agentDir: string };
	/** The journal path and its code cells. Throws when the journal cannot be materialized. */
	journal(): { path: string; cells: NotebookCodeCell[] };
	/** The verified Deno binary. Downloads it on first use. */
	deno(signal?: AbortSignal): Promise<string>;
	/** Names the project state and the checkpoint bind in the kernel. Diagnostics knows them. */
	restoredBindings(): ReadonlySet<string>;
	/** True when the configured profile is loaded into this session. */
	profileActive(): boolean;
	/** Kills the running cell and writes no checkpoint. Returns the cell id it killed. */
	stopWithoutCheckpoint(): Promise<string | undefined>;
	resetProjectState(): Promise<{ generation: string; previousBindings: number }>;
	removeCheckpoint(): void;
	startClean(signal?: AbortSignal): Promise<void>;
	checkpointEmpty(): Promise<void>;
}

export class NotebookRecoveryController {
	private readonly host: NotebookRecoveryHost;
	private readonly maxBytes: number;
	private readonly profile: string | undefined;

	constructor(options: { maxBytes: number; profile?: string | undefined }, host: NotebookRecoveryHost) {
		this.host = host;
		this.maxBytes = options.maxBytes;
		this.profile = options.profile;
	}

	async diagnostics(signal?: AbortSignal): Promise<NotebookRecoveryResult> {
		const identity = this.host.identity();
		let journal: { path: string; cells: NotebookCodeCell[] };
		try {
			journal = this.host.journal();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { message: `Notebook diagnostics could not read the journal: ${reason}`, details: { error: reason } };
		}
		const deno = await this.host.deno(signal);
		const runtimeBindings = new Set([
			...this.host.restoredBindings(),
			...(this.host.profileActive()
				? notebookProfileBindingNames(this.profile, identity.agentDir, this.maxBytes)
				: []),
		]);
		return diagnoseNotebook({
			deno,
			cwd: identity.project,
			path: journal.path,
			cells: journal.cells,
			runtimeBindings,
			signal,
		});
	}

	async reset(signal?: AbortSignal): Promise<NotebookRecoveryResult> {
		signal?.throwIfAborted();
		const identity = this.host.identity();
		const terminatedCell = await this.host.stopWithoutCheckpoint();
		const projectReset = await this.host.resetProjectState();
		resetNotebookNpmImports(identity);
		this.host.removeCheckpoint();
		await this.host.startClean(signal);
		await this.host.checkpointEmpty();
		const discarded = `${projectReset.previousBindings} project binding${projectReset.previousBindings === 1 ? "" : "s"}`;
		return {
			message: `Notebook reset to empty state; discarded ${discarded}${terminatedCell ? ` and terminated ${terminatedCell}` : ""}. Saved notebooks and named profiles were preserved; use exec to establish repaired state`,
			details: {
				project: identity.project,
				projectGeneration: projectReset.generation,
				discardedProjectBindings: projectReset.previousBindings,
				...(terminatedCell ? { terminatedCell } : {}),
			},
		};
	}
}
