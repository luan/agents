import { setTimeout as delay } from "node:timers/promises";
import { type ExtensionAPI, InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount, splitRule } from "./format-tokens";

const patchKey = Symbol.for("agents.pi.compaction-phases.patch");
const phaseSetterKey = Symbol.for("agents.pi.compaction-phases.set");
const reasonOverrideKey = Symbol.for("agents.pi.compaction-reason.override");
const indicatorPatchKey = Symbol.for("agents.pi.compaction-phases.indicator-patch");
// Pi queues terminal renders and throttles them to a 16 ms interval.
const finalizingRenderDwellMs = 32;

type CompactionPhase = "preparing" | "summarizing" | "finalizing";
type CompactionReason = "manual" | "threshold" | "overflow";

type CompactionIndicator = {
	[indicatorPatchKey]?: boolean;
	kind?: string;
	setMessage?: (message: string) => void;
	render?: (width: number) => string[];
	frames?: string[];
	currentFrame?: number;
	renderIndicatorVerbatim?: boolean;
	spinnerColorFn?: (spinner: string) => string;
	messageColorFn?: (message: string) => string;
	message?: string;
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
	tokensBefore?: number;
	reason?: CompactionReason;
};

const phaseStateKey = Symbol.for("agents.pi.compaction-phases.state");
const globalPhaseState = globalThis as typeof globalThis & {
	[phaseStateKey]?: PhaseState;
	[phaseSetterKey]?: (phase: CompactionPhase, tokensBefore?: number, reason?: CompactionReason) => void;
	[reasonOverrideKey]?: CompactionReason;
};
const phaseState = globalPhaseState[phaseStateKey] ?? {};
globalPhaseState[phaseStateKey] = phaseState;
globalPhaseState[phaseSetterKey] = setCompactionPhase;

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
	const action = {
		preparing: "Preparing",
		summarizing: "Summarizing",
		finalizing: "Finalizing",
	}[phase];
	const subject =
		phaseState.tokensBefore === undefined ? "context" : `${formatTokenCount(phaseState.tokensBefore)} tokens`;
	const reason = phaseState.reason === undefined ? "" : ` (${phaseState.reason})`;
	return `${action} ${subject}…${reason}`;
}

function setCompactionPhase(phase: CompactionPhase, tokensBefore?: number, reason?: CompactionReason): void {
	const tokensChanged = tokensBefore !== undefined && tokensBefore !== phaseState.tokensBefore;
	const effectiveReason = globalPhaseState[reasonOverrideKey] ?? reason;
	const reasonChanged = effectiveReason !== undefined && effectiveReason !== phaseState.reason;
	if (tokensBefore !== undefined) phaseState.tokensBefore = tokensBefore;
	if (effectiveReason !== undefined) phaseState.reason = effectiveReason;
	if (phaseState.activeCompactionPhase === phase && !tokensChanged && !reasonChanged) return;
	phaseState.activeCompactionPhase = phase;
	phaseState.activeCompactionIndicator?.setMessage?.(phaseMessage(phase));
}

function renderCompactionIndicator(indicator: CompactionIndicator, width: number): string[] {
	width = Math.max(1, width);
	const frame = indicator.frames?.[indicator.currentFrame ?? 0] ?? "";
	const spinner = indicator.renderIndicatorVerbatim ? frame : (indicator.spinnerColorFn?.(frame) ?? frame);
	const message = indicator.messageColorFn?.(indicator.message ?? "") ?? indicator.message ?? "";
	const label = frame ? `${spinner} ${message}` : message;
	const split = splitRule(width, visibleWidth(label));
	if (!split) return ["", truncateToWidth(label, width, "")];
	const rule = indicator.messageColorFn ?? ((text: string) => text);
	return ["", `${rule(split.left)} ${label} ${rule(split.right)}`];
}

function installIndicatorPatch(indicator: CompactionIndicator): void {
	if (indicator[indicatorPatchKey]) return;
	indicator[indicatorPatchKey] = true;
	indicator.render = (width) => renderCompactionIndicator(indicator, width);
}

function clearActiveCompactionIndicator(mode?: InteractiveModeLike): void {
	if (mode && phaseState.activeCompactionMode !== mode) return;
	phaseState.activeCompactionIndicator = undefined;
	phaseState.activeCompactionMode = undefined;
	phaseState.activeCompactionPhase = undefined;
	phaseState.tokensBefore = undefined;
	phaseState.reason = undefined;
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
			installIndicatorPatch(indicator);
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
		if (phaseState.reason) {
			const details = args[3];
			if (details === undefined) {
				args[3] = { compactionDivider: { reason: phaseState.reason } };
			} else if (details && typeof details === "object" && !Array.isArray(details)) {
				args[3] = { ...details, compactionDivider: { reason: phaseState.reason } };
			}
		}
		return appendCompaction.apply(this, args);
	};
	prototype[patchKey] = true;
}

export function installCompactionPhasePatch(pi: ExtensionAPI): void {
	// Pi keeps the compaction indicator behind InteractiveMode internals and does not expose start/end hooks.
	installInteractiveModePatch();
	installSessionManagerPatch();
	pi.on("session_before_compact", (event) => {
		setCompactionPhase("summarizing", event.preparation.tokensBefore, event.reason);
	});
	pi.on("session_compact", async () => {
		await waitForFinalizingRender();
	});
}
