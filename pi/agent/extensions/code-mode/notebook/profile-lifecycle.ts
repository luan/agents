/**
 * The named profile actions: list, save, load.
 *
 * Loading is BY VALUE. The host restores captured bytes into the live kernel and never replays the
 * cells that produced them, because a replay would re-run every side effect those cells had.
 *
 * The kernel lives behind `NotebookProfileHost`, so this module never touches the session, the
 * checkpoint files, or the project state files.
 */

import { globMatcher } from "./glob.ts";
import {
	listNotebookProfiles,
	type NotebookProfileCapture,
	NotebookProfileRestoreError,
	type NotebookProfileSnapshot,
	readNotebookProfile,
	writeNotebookProfile,
} from "./profile-state.ts";
import { type ProfileStateSummary, profileSummary } from "./profile-state-format.ts";

const MESSAGE_BUDGET = 16 * 1024;

export interface NotebookProfileHost {
	/** The exec cell running now, if any. A profile action never runs beside one. */
	activeCellId(): string | undefined;
	checkpoint(): Promise<void>;
	markChanged(): void;
	storage(): { agentDir: string; maxBytes: number };
	project(): string;
	/** Top-level kernel bindings, baseline names already removed. */
	liveBindings(signal?: AbortSignal): Promise<ReadonlySet<string>>;
	/** Serializes the named bindings out of the kernel. */
	capture(names: string[], signal?: AbortSignal): Promise<NotebookProfileCapture>;
	/** Injects the snapshot back into the kernel. No cell is replayed. */
	restore(snapshot: NotebookProfileSnapshot, signal?: AbortSignal): Promise<void>;
	/** Returns the session to its pre-load state after a failed restore. */
	rollback(): Promise<void>;
}

export interface NotebookProfileResult {
	message: string;
	details: Record<string, unknown>;
}

export class NotebookProfileController {
	private readonly host: NotebookProfileHost;

	constructor(host: NotebookProfileHost) {
		this.host = host;
	}

	list(query?: string): NotebookProfileResult {
		const matches = query === undefined ? undefined : globMatcher(query);
		const profiles = listNotebookProfiles(this.host.storage().agentDir).filter(
			({ name }) => !matches || matches(name),
		);
		return {
			message: formatProfiles(profiles, query),
			details: { profiles, ...(query === undefined ? {} : { query }) },
		};
	}

	async save(name: string, signal?: AbortSignal): Promise<NotebookProfileResult> {
		this.assertIdle("save");
		await this.host.checkpoint();
		const names = [...(await this.host.liveBindings(signal))].sort();
		const capture = await this.host.capture(names, signal);
		const summary = writeNotebookProfile({
			name,
			agentDir: this.host.storage().agentDir,
			sourceProject: this.host.project(),
			capture,
		});
		return {
			message: `Saved notebook profile ${summary.name}: ${summary.values} value(s), ${summary.definitions} definition(s), ${summary.skipped} skipped`,
			details: { ...summary },
		};
	}

	async load(name: string, signal?: AbortSignal): Promise<NotebookProfileResult> {
		this.assertIdle("load");
		const storage = this.host.storage();
		await this.host.checkpoint();
		const snapshot = readNotebookProfile(name, storage.agentDir, storage.maxBytes);
		const live = await this.host.liveBindings(signal);
		const collisions = snapshot.manifest.entries
			.map(({ name: binding }) => binding)
			.filter((binding) => live.has(binding));
		if (collisions.length > 0) {
			throw new Error(
				`Notebook profile ${name} conflicts with existing bindings: ${bound(collisions.join(", "))}. Release or rename them before loading`,
			);
		}
		try {
			await this.host.restore(snapshot, signal);
		} catch (error) {
			await this.host.rollback();
			throw new NotebookProfileRestoreError(
				`Notebook profile could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		const loaded = snapshot.manifest.entries.map(({ name: binding }) => binding);
		if (loaded.length > 0) {
			this.host.markChanged();
			await this.host.checkpoint();
		}
		const summary = profileSummary(snapshot.manifest);
		return {
			message: `Loaded notebook profile ${name}: ${summary.values} value(s), ${summary.definitions} definition(s)`,
			details: { summary, loaded },
		};
	}

	private assertIdle(action: string): void {
		const activeCell = this.host.activeCellId();
		if (activeCell) throw new Error(`Cannot ${action} a notebook profile while exec cell "${activeCell}" is running`);
	}
}

function formatProfiles(profiles: ProfileStateSummary[], query: string | undefined): string {
	if (profiles.length === 0) {
		return query === undefined ? "No notebook profiles saved" : `No notebook profiles match ${JSON.stringify(query)}`;
	}
	return bound(
		[
			`Notebook profiles${query === undefined ? "" : ` matching ${JSON.stringify(query)}`}:`,
			...profiles.map(
				(profile) =>
					`- ${profile.name}: ${profile.values} value(s), ${profile.definitions} definition(s), saved ${profile.createdAt}`,
			),
		].join("\n"),
	);
}

function bound(value: string): string {
	const marker = "\n[Notebook profile output truncated; narrow query]";
	return value.length <= MESSAGE_BUDGET ? value : `${value.slice(0, MESSAGE_BUDGET - marker.length)}${marker}`;
}
