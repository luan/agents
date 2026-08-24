import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tuiTheme } from "pi-libtui";
import type { CacheDiagnosticsMode } from "../contributions/xsettings.ts";
import type {
	CodexDiagnosticsEvent,
	CodexDiagnosticsFailure,
	CodexDiagnosticsLane,
	CodexDiagnosticsSink,
} from "../provider/types.ts";
import { createCodexDiagnosticsLog, type CodexDiagnosticsLog } from "./logger.ts";

const STATUS_KEY = "codex-cache";
const STATUS_TITLE = "Codex Cache";
export const CACHE_MISS_HOLD_MS = 3_000;

export interface CodexDiagnosticsStatus {
	record: CodexDiagnosticsSink;
	shutdown(): Promise<void>;
}

function laneLabel(lane: CodexDiagnosticsLane): string | undefined {
	return lane === "response" ? undefined : lane;
}

function requestTransportLabel(event: Extract<CodexDiagnosticsEvent, { type: "request" }>): string {
	if (event.transport === "sse") return "SSE full";
	if (event.continuation === "delta") return "WS delta";
	return event.continuation ? `WS full (${event.continuation.replaceAll("_", " ")})` : "WS full";
}

function failureLabel(failure: CodexDiagnosticsFailure): string {
	return [failure.category.replaceAll("_", " "), failure.code, failure.status]
		.filter((value) => value !== undefined)
		.join(" • ");
}

function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Diagnostics failures must not affect provider execution.
	}
}

export async function createCodexDiagnosticsStatus(options: {
	mode: Exclude<CacheDiagnosticsMode, "off">;
	ctx: ExtensionContext;
	agentDir: string;
	announceLog?: boolean | undefined;
	missHoldMs?: number | undefined;
	createLog?: typeof createCodexDiagnosticsLog;
}): Promise<CodexDiagnosticsStatus> {
	const { ctx } = options;
	let log: CodexDiagnosticsLog | undefined;
	let logActive = false;
	let logFailureReported = false;
	let statusFailed = false;
	let statusFailureReported = false;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let holdingMiss = false;
	let latestAfterMiss: string | undefined;
	const latestRequests = new Map<CodexDiagnosticsLane, Extract<CodexDiagnosticsEvent, { type: "request" }>>();

	const reportStatusFailure = (error: unknown) => {
		statusFailed = true;
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// The status boundary is already disabled.
			}
		}
		if (statusFailureReported) return;
		statusFailureReported = true;
		safeNotify(ctx, `Codex cache status stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
	};
	const themedStatus = (suffix: string, warning = false): string | undefined => {
		if (statusFailed || !ctx.hasUI) return undefined;
		try {
			const colors = tuiTheme(ctx.ui.theme);
			const title = colors.fg("accent", STATUS_TITLE);
			const detail = colors.fg(warning ? "warning" : "text.muted", ` • ${suffix}`);
			return `${title}${detail}`;
		} catch (error) {
			reportStatusFailure(error);
			return undefined;
		}
	};
	const show = (status: string | undefined) => {
		if (statusFailed || !ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, status);
		} catch (error) {
			reportStatusFailure(error);
		}
	};
	const showCurrent = (suffix: string) => {
		if (statusFailed || !ctx.hasUI) return;
		const status = themedStatus(`${suffix}${logActive ? " • log" : ""}`);
		if (status === undefined) return;
		if (holdingMiss) latestAfterMiss = status;
		else show(status);
	};
	const holdMiss = (suffix: string) => {
		if (statusFailed || !ctx.hasUI) return;
		if (holdTimer) clearTimeout(holdTimer);
		holdingMiss = true;
		latestAfterMiss = undefined;
		const status = themedStatus(`${suffix}${logActive ? " • log" : ""}`, true);
		if (status === undefined) return;
		show(status);
		holdTimer = setTimeout(() => {
			holdingMiss = false;
			holdTimer = undefined;
			if (latestAfterMiss) show(latestAfterMiss);
			latestAfterMiss = undefined;
		}, options.missHoldMs ?? CACHE_MISS_HOLD_MS);
		holdTimer.unref?.();
	};
	const reportLogFailure = (error: unknown) => {
		logActive = false;
		if (logFailureReported) return;
		logFailureReported = true;
		safeNotify(
			ctx,
			`Codex cache logging stopped: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	};

	if (options.mode === "status-and-log") {
		try {
			log = await (options.createLog ?? createCodexDiagnosticsLog)({
				agentDir: options.agentDir,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionName: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
				modelProvider: ctx.model?.provider,
				modelId: ctx.model?.id,
				onError: reportLogFailure,
			});
			logActive = true;
			if (options.announceLog) safeNotify(ctx, `Codex cache log: ${log.path}`, "info");
		} catch (error) {
			reportLogFailure(error);
		}
	}

	showCurrent("waiting");

	return {
		record(event) {
			log?.record(event);
			if (event.type === "request") {
				latestRequests.set(event.lane, event);
				showCurrent([laneLabel(event.lane), requestTransportLabel(event)].filter(Boolean).join(" • "));
				return;
			}
			if (event.type === "usage") {
				const totalInput = event.inputTokens + event.cachedInputTokens + event.cacheWriteInputTokens;
				const request = latestRequests.get(event.lane);
				const transport = request ? requestTransportLabel(request) : event.transport === "websocket" ? "WS" : "SSE";
				const prefix = laneLabel(event.lane);
				if (event.cachedInputTokens === 0 && totalInput > 0) {
					holdMiss([prefix, "MISS", transport].filter(Boolean).join(" • "));
					return;
				}
				showCurrent([prefix, totalInput > 0 ? "HIT" : "cache unavailable", transport].filter(Boolean).join(" • "));
				return;
			}
			if (event.type === "prewarm-ready") {
				showCurrent(`prewarm ready • WS ${event.socketReused ? "reused" : "new"}`);
				return;
			}
			if (event.type === "retry") {
				showCurrent(
					`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}${event.transport === "websocket" ? "WS" : "SSE"} retry ${event.attempt}`,
				);
				return;
			}
			if (event.type === "fallback") {
				showCurrent(`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}WS → SSE`);
				return;
			}
			showCurrent(
				`${laneLabel(event.lane) ? `${laneLabel(event.lane)} • ` : ""}${event.transport === "websocket" ? "WS" : "SSE"} failed: ${failureLabel(event.failure)}`,
			);
		},
		async shutdown() {
			if (holdTimer) clearTimeout(holdTimer);
			const failures: unknown[] = [];
			if (ctx.hasUI) {
				try {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} catch {
					// Diagnostics shutdown must not affect session shutdown.
				}
			}
			try {
				await log?.close();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Codex cache diagnostics shutdown failed");
		},
	};
}
