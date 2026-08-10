import { setTimeout as delay } from "node:timers/promises";
import { type ExtensionAPI, InteractiveMode, keyText, SessionManager } from "@earendil-works/pi-coding-agent";

const patchKey = Symbol.for("agents.pi.compaction-phases.patch");
// Pi queues terminal renders and throttles them to a 16 ms interval.
const finalizingRenderDwellMs = 32;

type CompactionPhase = "preparing" | "summarizing" | "finalizing";

type CompactionIndicator = {
	kind?: string;
	setMessage?: (message: string) => void;
};

type InteractiveModeLike = {
	activeStatusIndicator?: CompactionIndicator;
};

type InteractiveModePrototype = {
	[patchKey]?: boolean;
	showStatusIndicator(this: InteractiveModeLike, indicator: unknown): void;
	clearStatusIndicator(this: InteractiveModeLike, kind?: string): void;
};

type SessionManagerPrototype = {
	[patchKey]?: boolean;
	appendCompaction(this: unknown, ...args: unknown[]): string;
};

type PhaseState = {
	activeCompactionIndicator?: CompactionIndicator;
	activeCompactionMode?: InteractiveModeLike;
	activeCompactionPhase?: CompactionPhase;
};

const phaseStateKey = Symbol.for("agents.pi.compaction-phases.state");
const globalPhaseState = globalThis as typeof globalThis & { [phaseStateKey]?: PhaseState };
const phaseState = globalPhaseState[phaseStateKey] ?? {};
globalPhaseState[phaseStateKey] = phaseState;

function isCompactionIndicator(value: unknown): value is CompactionIndicator {
	if (!value || typeof value !== "object") return false;
	const indicator = value as CompactionIndicator;
	return indicator.kind === "compaction" && typeof indicator.setMessage === "function";
}
function isRetryIndicator(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const indicator = value as CompactionIndicator;
	return indicator.kind === "retry";
}

function phaseMessage(phase: CompactionPhase): string {
	const interrupt = keyText("app.interrupt") || "esc";
	const label = {
		preparing: "Preparing context...",
		summarizing: "Summarizing context...",
		finalizing: "Finalizing context...",
	}[phase];
	return `${label} (${interrupt} to cancel)`;
}

function setCompactionPhase(phase: CompactionPhase): void {
	if (!phaseState.activeCompactionIndicator || phaseState.activeCompactionPhase === phase) return;
	phaseState.activeCompactionPhase = phase;
	phaseState.activeCompactionIndicator.setMessage?.(phaseMessage(phase));
}

function clearActiveCompactionIndicator(mode?: InteractiveModeLike): void {
	if (mode && phaseState.activeCompactionMode !== mode) return;
	phaseState.activeCompactionIndicator = undefined;
	phaseState.activeCompactionMode = undefined;
	phaseState.activeCompactionPhase = undefined;
}
async function waitForFinalizingRender(): Promise<void> {
	if (phaseState.activeCompactionPhase !== "finalizing") return;
	await delay(finalizingRenderDwellMs);
}

function installInteractiveModePatch(): void {
	const prototype = InteractiveMode.prototype as unknown as Partial<InteractiveModePrototype>;
	if (prototype[patchKey]) return;

	const showStatusIndicator = prototype.showStatusIndicator;
	const clearStatusIndicator = prototype.clearStatusIndicator;
	if (!showStatusIndicator || !clearStatusIndicator) return;

	prototype.showStatusIndicator = function showStatusIndicatorWithCompactionPhase(
		this: InteractiveModeLike,
		indicator: unknown,
	): void {
		showStatusIndicator.call(this, indicator);
		if (isCompactionIndicator(indicator)) {
			// Summary retries replace the loader without another session_before_compact event.
			const phase = phaseState.activeCompactionPhase === "summarizing" ? "summarizing" : "preparing";
			phaseState.activeCompactionIndicator = indicator;
			phaseState.activeCompactionMode = this;
			phaseState.activeCompactionPhase = undefined;
			setCompactionPhase(phase);
		} else if (
			isRetryIndicator(indicator) &&
			phaseState.activeCompactionMode === this &&
			phaseState.activeCompactionPhase === "summarizing"
		) {
			// Retry status temporarily replaces the compaction loader before a new one is created.
			phaseState.activeCompactionIndicator = undefined;
		} else {
			clearActiveCompactionIndicator(this);
		}
	};

	prototype.clearStatusIndicator = function clearStatusIndicatorWithCompactionPhase(
		this: InteractiveModeLike,
		kind?: string,
	): void {
		clearStatusIndicator.call(this, kind);
		if (kind === undefined || kind === "compaction") {
			clearActiveCompactionIndicator(this);
		}
	};

	prototype[patchKey] = true;
}

function installSessionManagerPatch(): void {
	const prototype = SessionManager.prototype as unknown as Partial<SessionManagerPrototype>;
	if (prototype[patchKey]) return;

	const appendCompaction = prototype.appendCompaction;
	if (!appendCompaction) return;

	prototype.appendCompaction = function appendCompactionWithPhase(this: unknown, ...args: unknown[]): string {
		setCompactionPhase("finalizing");
		return appendCompaction.apply(this, args);
	};
	prototype[patchKey] = true;
}

export function installCompactionPhasePatch(pi: ExtensionAPI): void {
	// Pi keeps the compaction indicator behind InteractiveMode internals and does not expose start/end hooks.
	installInteractiveModePatch();
	installSessionManagerPatch();
	pi.on("session_before_compact", () => {
		setCompactionPhase("summarizing");
	});
	pi.on("session_compact", async () => {
		await waitForFinalizingRender();
	});
}
