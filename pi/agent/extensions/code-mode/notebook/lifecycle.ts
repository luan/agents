/**
 * The twelve `notebook` actions.
 *
 * Three controllers split the work. Profiles (list, save, load) live in `profile-lifecycle.ts` and
 * recovery (diagnostics, reset) in `recovery.ts`; this file owns the other seven and routes the
 * rest. The session lives behind `NotebookLifecycleHost`, so nothing here touches the kernel
 * process, the checkpoint files, or the project state files.
 *
 * Two rules the actions never bend:
 * - Pins survive `release` and `prune`. Only `unpin` clears one.
 * - `prune` requires a caller-selected glob. `globMatcher("")` throws, so prune never matches all.
 */

import { randomUUID } from "node:crypto";
import { globMatcher } from "./glob.ts";
import {
	boundedReleaseDetails,
	formatNameList,
	formatRelease,
	formatStatus,
	largestUnpinned,
	NOTEBOOK_DETAILS_BUDGET,
	type NotebookMatchedBinding,
	type NotebookStatusDetails,
	takeDetailValues,
	withinNameBudget,
} from "./lifecycle-result.ts";
import {
	isIdentifier,
	type NotebookKernelStatus,
	type NotebookMemoryUsage,
	type NotebookReleaseResult,
	notebookDisposeSource,
	notebookReleaseSource,
	notebookStatusSource,
	parseNotebookRuntimeResult,
} from "./lifecycle-runtime.ts";
import type { NotebookProfileController } from "./profile-lifecycle.ts";
import type { NotebookKernelExecutor } from "./project-state-format.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";
import type { NotebookRecoveryController } from "./recovery.ts";

/** Inspecting bindings runs kernel code, so it cannot block a control action forever. */
const STATUS_TIMEOUT_MS = 8_000;

export type NotebookAction =
	| "status"
	| "list"
	| "checkpoint"
	| "save"
	| "load"
	| "pin"
	| "unpin"
	| "release"
	| "prune"
	| "restart"
	| "diagnostics"
	| "reset";

export type NotebookControlRequest =
	| { action: "status" | "list"; query?: string | undefined }
	| { action: "save" | "load"; name: string }
	| { action: "pin" | "unpin" | "release"; names: string[] }
	| { action: "prune"; query: string }
	| { action: "checkpoint" | "restart" | "diagnostics" | "reset" };

export interface NotebookControlResult {
	message: string;
	details: Record<string, unknown>;
}

export interface NotebookLifecycleMetadata {
	startedAt?: number | undefined;
	userCells: number;
	memory?: NotebookMemoryUsage | undefined;
	/** `NotebookCheckpointManager.status()`, passed through untouched. */
	checkpoint: Record<string, unknown>;
}

export interface NotebookLifecycleHost {
	/** Starts the kernel when it is not running. Every action but list, diagnostics, and reset needs one. */
	prepare(signal?: AbortSignal): Promise<void>;
	kernel(): NotebookKernelExecutor | undefined;
	activeCellId(): string | undefined;
	/** Kills the running cell and returns its id. */
	stopActive(): Promise<string | undefined>;
	/** Top-level kernel bindings, baseline names already removed. */
	liveBindings(signal?: AbortSignal): Promise<ReadonlySet<string>>;
	checkpoint(excludeNames?: ReadonlySet<string>, pins?: ProjectStatePinUpdate): Promise<void>;
	retainedBindings(): RetainedProjectBinding[];
	/**
	 * Marks the names as project bindings in the kernel, and returns the undo for that marking.
	 * The undo runs when the metadata commit fails, so a rejected pin leaves no promoted tracking.
	 */
	promoteBindings(names: string[], signal?: AbortSignal): Promise<() => Promise<void>>;
	markChanged(): void;
	/** Restarts the kernel from the last completed checkpoint. Returns a restore notice, if any. */
	restart(signal?: AbortSignal): Promise<string | undefined>;
	metadata(): NotebookLifecycleMetadata;
}

export class NotebookLifecycleController {
	private readonly host: NotebookLifecycleHost;
	private readonly profiles: NotebookProfileController;
	private readonly recovery: NotebookRecoveryController;

	constructor(host: NotebookLifecycleHost, profiles: NotebookProfileController, recovery: NotebookRecoveryController) {
		this.host = host;
		this.profiles = profiles;
		this.recovery = recovery;
	}

	async control(request: NotebookControlRequest, signal?: AbortSignal): Promise<NotebookControlResult> {
		// list reads the profile directory, diagnostics reads the journal, reset rebuilds the kernel.
		// None of the three needs a running kernel, so none pays to start one.
		if (request.action === "list") return this.profiles.list(request.query);
		if (request.action === "diagnostics") return this.recovery.diagnostics(signal);
		if (request.action === "reset") return this.recovery.reset(signal);
		await this.host.prepare(signal);
		switch (request.action) {
			case "status":
				return this.status(request.query, signal);
			case "checkpoint":
				return this.checkpoint();
			case "save":
				return this.profiles.save(request.name, signal);
			case "load":
				return this.profiles.load(request.name, signal);
			case "pin":
				return this.pin(request.names, true, signal);
			case "unpin":
				return this.pin(request.names, false, signal);
			case "release":
				return this.release(request.names, signal);
			case "prune":
				return this.prune(request.query, signal);
			case "restart":
				return this.restart(signal);
		}
	}

	/** Disposes every user binding without deleting it. The caller is about to replace the kernel. */
	async disposeAll(signal?: AbortSignal): Promise<NotebookReleaseResult | undefined> {
		const kernel = this.host.kernel();
		if (!kernel || this.host.activeCellId()) return undefined;
		const names = await this.userBindingNames(signal);
		if (names.length === 0) return { released: [], disposed: [], failures: [] };
		const marker = lifecycleMarker();
		return parseNotebookRuntimeResult<NotebookReleaseResult>(
			await kernel.execute(notebookDisposeSource(names, marker), { signal }),
			marker,
		);
	}

	private async status(query: string | undefined, signal?: AbortSignal): Promise<NotebookControlResult> {
		const activeCell = this.host.activeCellId();
		const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
		const statusSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		// A running cell owns the kernel. Inspecting it would queue behind the cell, so status reports
		// only what the host already knows.
		const allNames = activeCell ? [] : await this.userBindingNames(statusSignal);
		const matches = query === undefined ? [] : allNames.filter(globMatcher(query));
		const retained = this.host.retainedBindings();
		const retainedByName = new Map(retained.map((binding) => [binding.name, binding]));
		const runtime = activeCell ? undefined : await this.inspect(withinNameBudget(matches), statusSignal);
		const metadata = this.host.metadata();
		const budget = { remaining: NOTEBOOK_DETAILS_BUDGET };
		const inspected: NotebookMatchedBinding[] = (runtime?.bindings ?? []).map((binding) => {
			const durable = retainedByName.get(binding.name);
			return {
				...binding,
				...(durable ? { bytes: durable.bytes, updatedAt: durable.updatedAt, pinned: durable.pinned } : {}),
			};
		});
		const reportedMatches = takeDetailValues(inspected, budget);
		const pinned = retained.filter((binding) => binding.pinned);
		const reportedPinned = takeDetailValues(pinned, budget);
		const details: NotebookStatusDetails = {
			state: activeCell ? "running" : "idle",
			...(activeCell ? { activeCell } : {}),
			userBindings: activeCell ? undefined : allNames.length,
			userCells: metadata.userCells,
			...(metadata.startedAt ? { startedAt: new Date(metadata.startedAt).toISOString() } : {}),
			memory: runtime?.memory ?? metadata.memory,
			checkpoint: metadata.checkpoint,
			retainedBindings: retained.length,
			retainedBytes: retained.reduce((total, binding) => total + binding.bytes, 0),
			pinnedBindings: pinned.length,
			pinned: reportedPinned,
			omittedPinned: pinned.length - reportedPinned.length,
			largestUnpinned: largestUnpinned(retained),
			...(query === undefined
				? {}
				: {
						query,
						matches: reportedMatches,
						omittedMatches: Math.max(0, matches.length - reportedMatches.length),
					}),
		};
		return { message: formatStatus(details), details };
	}

	private async checkpoint(): Promise<NotebookControlResult> {
		await this.host.checkpoint();
		return { message: "Notebook checkpoint complete", details: this.host.metadata().checkpoint };
	}

	/**
	 * Pin promotion and the metadata commit are one operation. The commit takes the project lock and
	 * writes the pin flags; a failed commit undoes the promotion, so kernel tracking and the manifest
	 * never disagree.
	 */
	private async pin(names: string[], pinned: boolean, signal?: AbortSignal): Promise<NotebookControlResult> {
		const activeCell = this.host.activeCellId();
		if (activeCell) throw new Error(`Cannot change notebook pins while exec cell "${activeCell}" is running`);
		let undoPromotion: (() => Promise<void>) | undefined;
		if (pinned) {
			await this.assertBindable(names, "pinnable", signal);
			undoPromotion = await this.host.promoteBindings(names, signal);
		}
		try {
			await this.host.checkpoint(undefined, { names, pinned });
		} catch (error) {
			await undoPromotion?.().catch(() => undefined);
			throw error;
		}
		const reported = new Set(withinNameBudget(names));
		const selected = this.host.retainedBindings().filter((binding) => reported.has(binding.name));
		const bindings = takeDetailValues(selected, { remaining: NOTEBOOK_DETAILS_BUDGET });
		return {
			message: `${pinned ? "Pinned" : "Unpinned"} durable notebook bindings: ${formatNameList(names)}`,
			details: { pinned, bindings, bindingCount: names.length, omittedBindings: names.length - bindings.length },
		};
	}

	private async release(
		names: string[],
		signal?: AbortSignal,
		preservedNames: string[] = [],
	): Promise<NotebookControlResult> {
		const activeCell = this.host.activeCellId();
		if (activeCell) {
			throw new Error(
				`Cannot release notebook state while exec cell "${activeCell}" is running; terminate or restart it first`,
			);
		}
		await this.assertBindable(names, "releasable", signal);
		const pinned = new Set(
			this.host
				.retainedBindings()
				.filter((binding) => binding.pinned)
				.map(({ name }) => name),
		);
		const protectedNames = names.filter((name) => pinned.has(name));
		if (protectedNames.length > 0) {
			throw new Error(
				`Pinned notebook bindings cannot be released: ${formatNameList(protectedNames)}; unpin them first`,
			);
		}
		const status = await this.inspect(names, signal);
		// `delete globalThis[name]` cannot remove a `let` or `const`. Those need a fresh kernel.
		const restartRequired = status.bindings.some(({ globalProperty }) => !globalProperty);
		let result: NotebookReleaseResult;
		if (restartRequired) {
			this.host.markChanged();
			await this.host.checkpoint(new Set(names));
			const disposal = await this.disposeAll(signal);
			await this.host.restart(signal);
			result = {
				released: [...names],
				disposed: disposal?.disposed ?? [],
				failures: disposal?.failures ?? [],
			};
		} else {
			const marker = lifecycleMarker();
			result = parseNotebookRuntimeResult<NotebookReleaseResult>(
				await this.kernel().execute(notebookReleaseSource(names, marker), { signal }),
				marker,
			);
			if (result.released.length > 0) {
				this.host.markChanged();
				await this.host.checkpoint(new Set(result.released));
			}
		}
		// Another session may have committed the same name back into the project state.
		const remaining = await this.host.liveBindings(signal);
		for (const name of [...result.released]) {
			if (!remaining.has(name)) continue;
			result.released.splice(result.released.indexOf(name), 1);
			result.failures.push({ name, reason: "concurrent project state retained this binding" });
		}
		return {
			message: formatRelease(result, restartRequired),
			details: boundedReleaseDetails(result, preservedNames, restartRequired, this.host.metadata().checkpoint),
		};
	}

	private async prune(query: string, signal?: AbortSignal): Promise<NotebookControlResult> {
		const matches = (await this.userBindingNames(signal)).filter(globMatcher(query));
		const pinned = new Set(
			this.host
				.retainedBindings()
				.filter((binding) => binding.pinned)
				.map(({ name }) => name),
		);
		const protectedNames = matches.filter((name) => pinned.has(name));
		const names = matches.filter((name) => !pinned.has(name));
		if (names.length === 0) {
			const details = boundedReleaseDetails(
				{ released: [], disposed: [], failures: [] },
				protectedNames,
				false,
				this.host.metadata().checkpoint,
			);
			const preserved = protectedNames.length > 0 ? `; protected: ${formatNameList(protectedNames)}` : "";
			return {
				message: `No unpinned notebook bindings matched ${JSON.stringify(query)}${preserved}`,
				details: { ...details, query },
			};
		}
		const released = await this.release(names, signal, protectedNames);
		const preserved =
			protectedNames.length > 0 ? `\nPinned matches preserved: ${formatNameList(protectedNames)}` : "";
		return { message: `${released.message}${preserved}`, details: { ...released.details, query } };
	}

	private async restart(signal?: AbortSignal): Promise<NotebookControlResult> {
		const activeCell = await this.host.stopActive();
		// A terminated cell may have left half-written state, so its kernel is not checkpointed.
		if (!activeCell) await this.host.checkpoint();
		const disposal = await this.disposeAll(signal).catch((error) => ({
			released: [],
			disposed: [],
			failures: [{ name: "notebook", reason: error instanceof Error ? error.message : String(error) }],
		}));
		const restoreNotice = await this.host.restart(signal);
		const failures = disposal?.failures ?? [];
		return {
			message: [
				`Notebook kernel restarted from the last completed checkpoint${activeCell ? `; terminated ${activeCell}` : ""}`,
				failures.length > 0
					? `${failures.length} resource cleanup failure${failures.length === 1 ? "" : "s"}; restart continued`
					: undefined,
				restoreNotice,
			]
				.filter((line) => line !== undefined)
				.join(". "),
			details: {
				...(activeCell ? { terminatedCell: activeCell } : {}),
				disposed: disposal?.disposed ?? [],
				disposalFailures: failures,
				...(restoreNotice ? { restoreNotice } : {}),
			},
		};
	}

	private async inspect(names: readonly string[], signal?: AbortSignal): Promise<NotebookKernelStatus> {
		const marker = lifecycleMarker();
		return parseNotebookRuntimeResult<NotebookKernelStatus>(
			await this.kernel().execute(notebookStatusSource(names, marker), { signal }),
			marker,
		);
	}

	private async assertBindable(names: string[], verb: string, signal?: AbortSignal): Promise<void> {
		const available = new Set(await this.userBindingNames(signal));
		const invalid = names.filter((name) => !available.has(name));
		if (invalid.length > 0) throw new Error(`Notebook bindings not found or not ${verb}: ${invalid.join(", ")}`);
	}

	/** Sorted user bindings. A name that is not an identifier cannot be inlined into kernel source. */
	private async userBindingNames(signal?: AbortSignal): Promise<string[]> {
		return [...(await this.host.liveBindings(signal))].filter(isIdentifier).sort();
	}

	private kernel(): NotebookKernelExecutor {
		const kernel = this.host.kernel();
		if (!kernel) throw new Error("Notebook kernel is not running");
		return kernel;
	}
}

function lifecycleMarker(): string {
	return `__PI_NOTEBOOK_LIFECYCLE_${randomUUID()}__`;
}
