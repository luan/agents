/**
 * mosaic — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   spawn_agent      — LLM-callable: spawn a named mosaic agent
 *   send_message     — LLM-callable: queue a message for an agent
 *   followup_task    — LLM-callable: queue work and trigger an agent turn
 *   wait_agent       — LLM-callable: wait for a mailbox/status update
 *
 * Commands:
 *   /mosaic settings        — Interactive agent/model settings menu
 *   /mosaic list            — List and manage mosaic sessions
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	ModelSelectorComponent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AgentManager } from "./agent-manager.js";
import { getDefaultMaxTurns, getGraceTurns, setDefaultMaxTurns, setGraceTurns } from "./agent-runner.js";
import { getAgentConfig, getAllTypes, registerAgents, resolveType } from "./agent-types.js";
import { isMosaicChildSession, registerMosaicBootstrap } from "./bootstrap.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { resolveAgentCwd } from "./cwd.js";
import { launchFullSessionAgent } from "./full-session-agent.js";
import { isTerminalAssistantMessage, resolveFullSessionAgentStatus } from "./full-session-status.js";
import { GroupJoinManager } from "./group-join.js";
import { deliverInProcessMessage } from "./in-process-message.js";
import {
	type MosaicAgentUpdate,
	MosaicMessageServer,
	type MosaicMessageTransport,
	startMosaicMessageTransport,
} from "./message-server.js";
import {
	formatModelPresetCandidates,
	isDefaultModelPreset,
	mergeModelPresets,
	orderedModelPresetNames,
	resolveModelPreset,
} from "./model-presets.js";
import { type ModelRegistry, resolveConfiguredModel, resolveModel } from "./model-resolver.js";
import { currentMultiplexerTarget, killTarget } from "./multiplexer.js";
import { hasMultiplexer, registerMosaicMux, resolveOwner, showMosaicSessions } from "./mux.js";
import * as muxHeartbeat from "./mux-heartbeat.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged } from "./settings.js";
import { createMosaicTools } from "./tools.js";
import type {
	AgentConfig,
	AgentRecord,
	JoinMode,
	ModelPresetCandidate,
	NotificationDetails,
	SubagentType,
} from "./types.js";
import {
	type AgentActivity,
	AgentWidget,
	formatDuration,
	formatMs,
	formatTokens,
	formatTurns,
	getDisplayName,
	type UICtx,
} from "./ui/agent-widget.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.js";

// ---- Shared helpers ----

interface FullSessionAgentRecord {
	id: string;
	laneId?: string;
	type: SubagentType;
	description: string;
	sessionFile: string;
	paneId: string;
	windowId: string;
	windowName: string;
	cwd?: string;
	startedAt: number;
	status: "running" | "completed" | "error" | "stopped";
	completedAt?: number;
	result?: string;
	error?: string;
	maxTurns?: number;
	modelName?: string;
	thinkingLevel?: AgentRecord["thinkingLevel"];
	resultDelivered?: boolean;
	worktree?: { path: string; branch: string };
	placement?: unknown;
	mosaicIdentity?: { label: string; color: string };
}

interface MosaicProcessState {
	protocolVersion: number;
	fullSessionAgents: Map<string, FullSessionAgentRecord>;
	messageServer: MosaicMessageServer;
	messageTransport?: Promise<MosaicMessageTransport>;
	messageUpdateUnsubscribe?: () => void;
}

const PROCESS_STATE_KEY = Symbol.for("mosaic:process-state");
const MOSAIC_NATIVE_PROTOCOL_VERSION = 4;

function getMosaicProcessState(): MosaicProcessState {
	const global = globalThis as typeof globalThis & { [PROCESS_STATE_KEY]?: MosaicProcessState };
	const existing = global[PROCESS_STATE_KEY];
	if (!existing) {
		global[PROCESS_STATE_KEY] = createMosaicProcessState();
		return global[PROCESS_STATE_KEY];
	}
	if (existing.protocolVersion !== MOSAIC_NATIVE_PROTOCOL_VERSION || !isCompatibleMosaicProcessState(existing)) {
		existing.messageTransport?.then((transport) => transport.close().catch(() => {})).catch(() => {});
		existing.messageUpdateUnsubscribe?.();
		global[PROCESS_STATE_KEY] = {
			...createMosaicProcessState(),
			fullSessionAgents: existing.fullSessionAgents,
		};
	}
	return global[PROCESS_STATE_KEY];
}

function isCompatibleMosaicProcessState(state: MosaicProcessState): boolean {
	return typeof state.messageServer?.onUpdate === "function";
}

function createMosaicProcessState(): MosaicProcessState {
	return {
		protocolVersion: MOSAIC_NATIVE_PROTOCOL_VERSION,
		fullSessionAgents: new Map(),
		messageServer: new MosaicMessageServer(),
	};
}

export function __getMosaicProcessStateForTest(): MosaicProcessState {
	return getMosaicProcessState();
}

export function __resetMosaicProcessStateForTest(): void {
	delete (globalThis as typeof globalThis & { [PROCESS_STATE_KEY]?: MosaicProcessState })[PROCESS_STATE_KEY];
}

interface SessionTranscriptSnapshot {
	result?: string;
	conversation?: string;
	hasAssistantMessage: boolean;
	assistantTimestamp?: number;
	error?: string;
}

function _readSessionConversationFile(
	sessionFile: string,
	verbose: boolean,
): { result?: string; conversation?: string } {
	const snapshot = readSessionTranscriptSnapshot(sessionFile, verbose);
	return { result: snapshot.result, conversation: snapshot.conversation };
}

function readSessionTranscriptSnapshot(sessionFile: string, verbose: boolean): SessionTranscriptSnapshot {
	const lines = readSessionJsonl(sessionFile);
	const conversation: string[] = [];
	let lastAssistantText = "";
	let hasAssistantMessage = false;
	let assistantTimestamp: number | undefined;
	let error: string | undefined;
	for (const entry of lines) {
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (!msg || typeof msg.role !== "string") continue;
		if (msg.role === "user") {
			const text = sessionMessageText(msg.content);
			if (text.trim() && verbose) conversation.push(`[User]: ${text.trim()}`);
			continue;
		}
		if (msg.role === "assistant") {
			const text = sessionMessageText(msg.content);
			const isTerminal = isTerminalAssistantMessage(msg);
			if (isTerminal) {
				hasAssistantMessage = true;
				assistantTimestamp = parseSessionEntryTimestamp(entry.timestamp) ?? assistantTimestamp;
			}
			if (text.trim() && isTerminal) {
				lastAssistantText = text.trim();
				if (verbose) conversation.push(`[Assistant]: ${lastAssistantText}`);
			}
			if (!text.trim()) {
				const raw = JSON.stringify(msg);
				if (raw.includes("usage_limit_reached")) error = "usage_limit_reached";
			}
		}
	}
	return {
		hasAssistantMessage,
		assistantTimestamp,
		result: lastAssistantText || undefined,
		error,
		conversation: conversation.length > 0 ? conversation.join("\n\n") : undefined,
	};
}

function readSessionStartedAt(sessionFile: string): number | undefined {
	for (const entry of readSessionJsonl(sessionFile)) {
		const timestamp = parseSessionEntryTimestamp(entry?.timestamp);
		if (timestamp != null) return timestamp;
	}
	return undefined;
}

function parseSessionEntryTimestamp(timestamp: unknown): number | undefined {
	if (typeof timestamp !== "string") return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function readSessionJsonl(sessionFile: string): any[] {
	if (!existsSync(sessionFile)) return [];
	try {
		return readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return undefined;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

function sessionMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const typed = part as { type?: unknown; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
	switch (status) {
		case "error":
			return `Error: ${error ?? "unknown"}`;
		case "aborted":
			return "Aborted (max turns exceeded)";
		case "steered":
			return "Wrapped up (turn limit)";
		case "stopped":
			return "Stopped";
		default:
			return "Done";
	}
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
	const status = getStatusLabel(record.status, record.error);
	const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
	const totalTokens = getLifetimeTotal(record.lifetimeUsage);
	const contextPercent = getSessionContextPercent(record.session);
	const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
	const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
	const modelXml = record.modelName ? `<model>${escapeXml(record.modelName)}</model>` : "";
	const effortXml = record.thinkingLevel ? `<effort>${escapeXml(record.thinkingLevel)}</effort>` : "";

	const resultPreview = record.result
		? record.result.length > resultMaxLen
			? `${record.result.slice(0, resultMaxLen)}\n...(truncated)`
			: record.result
		: "No output.";

	return [
		`<task-notification>`,
		`<task-id>${record.id}</task-id>`,
		record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
		record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
		`<status>${escapeXml(status)}</status>`,
		`<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
		`<result>${escapeXml(resultPreview)}</result>`,
		`<usage>${modelXml}${effortXml}<total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
		`</task-notification>`,
	]
		.filter(Boolean)
		.join("\n");
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(
	record: AgentRecord,
	resultMaxLen: number,
	activity?: AgentActivity,
): NotificationDetails {
	const totalTokens = getLifetimeTotal(record.lifetimeUsage);

	return {
		id: record.id,
		description: record.description,
		status: record.status,
		toolUses: record.toolUses,
		turnCount: activity?.turnCount ?? 0,
		maxTurns: activity?.maxTurns,
		modelName: record.modelName,
		thinkingLevel: record.thinkingLevel,
		totalTokens,
		durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
		outputFile: record.outputFile,
		error: record.error,
		resultPreview: record.result
			? record.result.length > resultMaxLen
				? `${record.result.slice(0, resultMaxLen)}…`
				: record.result
			: "No output.",
	};
}

export default function (pi: ExtensionAPI) {
	registerMosaicBootstrap(pi);
	registerMosaicMux(pi);

	// ---- Register custom notification renderer ----
	pi.registerMessageRenderer<NotificationDetails>("subagent-notification", (message, { expanded }, theme) => {
		const d = message.details;
		if (!d) return undefined;

		function renderOne(d: NotificationDetails): string {
			const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const statusText = isError ? d.status : d.status === "steered" ? "completed (steered)" : "completed";

			// Line 1: icon + agent description + status
			let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

			// Line 2: stats
			const parts: string[] = [];
			if (d.modelName) parts.push(d.modelName);
			if (d.thinkingLevel) parts.push(`effort ${d.thinkingLevel}`);
			if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
			if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
			if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
			if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
			if (parts.length) {
				line += `\n  ${parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)}`;
			}

			// Line 3: result preview (collapsed) or full (expanded)
			if (expanded) {
				const lines = d.resultPreview.split("\n").slice(0, 30);
				for (const l of lines) line += `\n${theme.fg("dim", `  ${l}`)}`;
			} else {
				const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
				line += `\n  ${theme.fg("dim", `⎿  ${preview}`)}`;
			}

			// Line 4: output file link (if present)
			if (d.outputFile) {
				line += `\n  ${theme.fg("muted", `transcript: ${d.outputFile}`)}`;
			}

			return line;
		}

		const all = [d, ...(d.others ?? [])];
		return new Text(all.map(renderOne).join("\n"), 0, 0);
	});

	/** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
	const reloadCustomAgents = () => {
		const userAgents = loadCustomAgents(process.cwd());
		registerAgents(userAgents);
	};

	// Initial load
	reloadCustomAgents();

	// ---- Agent activity tracking + widget ----
	const agentActivity = new Map<string, AgentActivity>();

	// ---- Cancellable pending notifications ----
	// Holds notifications briefly so callers can consume results before a nudge.
	// before they reach pi.sendMessage (fire-and-forget).
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
	const NUDGE_HOLD_MS = 200;

	function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
		cancelNudge(key);
		pendingNudges.set(
			key,
			setTimeout(() => {
				pendingNudges.delete(key);
				try {
					send();
				} catch {
					/* ignore stale completion side-effect errors */
				}
			}, delay),
		);
	}

	function cancelNudge(key: string) {
		const timer = pendingNudges.get(key);
		if (timer != null) {
			clearTimeout(timer);
			pendingNudges.delete(key);
		}
	}

	// ---- Individual nudge helper (async join mode) ----
	function emitIndividualNudge(record: AgentRecord) {
		if (record.resultConsumed) return; // re-check at send time

		const notification = formatTaskNotification(record, 500);
		const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

		pi.sendMessage<NotificationDetails>(
			{
				customType: "subagent-notification",
				content: notification + footer,
				display: true,
				details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	function sendIndividualNudge(record: AgentRecord) {
		agentActivity.delete(record.id);
		widget.markFinished(record.id);
		scheduleNudge(record.id, () => emitIndividualNudge(record));
		widget.update();
	}

	// ---- Group join manager ----
	const groupJoin = new GroupJoinManager((records, partial) => {
		for (const r of records) {
			agentActivity.delete(r.id);
			widget.markFinished(r.id);
		}

		const groupKey = `group:${records.map((r) => r.id).join(",")}`;
		scheduleNudge(groupKey, () => {
			// Re-check at send time
			const unconsumed = records.filter((r) => !r.resultConsumed);
			if (unconsumed.length === 0) {
				widget.update();
				return;
			}

			const notifications = unconsumed.map((r) => formatTaskNotification(r, 300)).join("\n\n");
			const label = partial
				? `${unconsumed.length} agent(s) finished (partial — others still running)`
				: `${unconsumed.length} agent(s) finished`;

			const [first, ...rest] = unconsumed;
			const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
			if (rest.length > 0) {
				details.others = rest.map((r) => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
			}

			pi.sendMessage<NotificationDetails>(
				{
					customType: "subagent-notification",
					content: `Background agent group completed: ${label}\n\n${notifications}`,
					display: true,
					details,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		});
		widget.update();
	}, 30_000);

	/** Helper: build event data for lifecycle events from an AgentRecord. */
	function buildEventData(record: AgentRecord) {
		const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
		// All three fields are lifetime-accumulated (Σ over every assistant message_end),
		// so they survive compaction together — input + output ≤ total always.
		// tokens is omitted when nothing was ever produced (e.g. agent errored before
		// any message_end fired), preserving prior payload shape.
		const u = record.lifetimeUsage;
		const total = getLifetimeTotal(u);
		const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
		return {
			id: record.id,
			type: record.type,
			description: record.description,
			result: record.result,
			error: record.error,
			status: record.status,
			toolUses: record.toolUses,
			durationMs,
			tokens,
		};
	}

	let inProcessSeq = 0;
	const inProcessUpdates: MosaicAgentUpdate[] = [];
	const inProcessWaiters: Array<{
		afterSeq: number;
		resolve: (update: MosaicAgentUpdate | undefined) => void;
		timer?: ReturnType<typeof setTimeout>;
	}> = [];

	function toMosaicAgentStatus(status: AgentRecord["status"]): MosaicAgentUpdate["status"] {
		switch (status) {
			case "queued":
				return "registered";
			case "running":
				return "running";
			case "completed":
				return "completed";
			case "stopped":
				return "closed";
			default:
				return "error";
		}
	}

	function recordInProcessUpdate(record: AgentRecord): MosaicAgentUpdate {
		inProcessSeq = Math.max(inProcessSeq, messageServer.currentSeq) + 1;
		const update: MosaicAgentUpdate = {
			type: "agent_update",
			seq: inProcessSeq,
			agentId: record.id,
			status: toMosaicAgentStatus(record.status),
			result: record.result,
			error: record.error,
			createdAt: Date.now(),
		};
		inProcessUpdates.push(update);
		if (inProcessUpdates.length > 100) inProcessUpdates.splice(0, inProcessUpdates.length - 100);
		for (const waiter of [...inProcessWaiters]) {
			if (update.seq <= waiter.afterSeq) continue;
			if (waiter.timer) clearTimeout(waiter.timer);
			inProcessWaiters.splice(inProcessWaiters.indexOf(waiter), 1);
			waiter.resolve(update);
		}
		return update;
	}

	function waitForInProcessUpdate(input: {
		afterSeq: number;
		timeoutMs?: number;
	}): Promise<MosaicAgentUpdate | undefined> {
		const existing = inProcessUpdates.find((update) => update.seq > input.afterSeq);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const waiter: (typeof inProcessWaiters)[number] = {
				afterSeq: input.afterSeq,
				resolve,
			};
			if (input.timeoutMs != null) {
				waiter.timer = setTimeout(() => {
					inProcessWaiters.splice(inProcessWaiters.indexOf(waiter), 1);
					resolve(undefined);
				}, input.timeoutMs);
				waiter.timer.unref?.();
			}
			inProcessWaiters.push(waiter);
		});
	}

	function waitForAnyAgentUpdate(input: { afterSeq?: number; timeoutMs?: number }): Promise<unknown> {
		const afterSeq = input.afterSeq ?? Math.max(messageServer.currentSeq, inProcessSeq);
		return Promise.race([
			messageServer.waitForUpdate({ afterSeq, timeoutMs: input.timeoutMs }),
			waitForInProcessUpdate({ afterSeq, timeoutMs: input.timeoutMs }),
		]);
	}

	// Background completion: route through group join or send individual nudge
	const manager = new AgentManager(
		(record) => {
			recordInProcessUpdate(record);
			// Emit lifecycle event based on terminal status
			const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
			const eventData = buildEventData(record);
			if (isError) {
				pi.events.emit("subagents:failed", eventData);
			} else {
				pi.events.emit("subagents:completed", eventData);
			}

			// Persist final record for cross-extension history reconstruction
			pi.appendEntry("subagents:record", {
				id: record.id,
				type: record.type,
				description: record.description,
				status: record.status,
				result: record.result,
				error: record.error,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
			});

			// Skip notification if result was already consumed by a caller.
			if (record.resultConsumed) {
				agentActivity.delete(record.id);
				widget.markFinished(record.id);
				widget.update();
				return;
			}

			// If this agent is pending batch finalization (debounce window still open),
			// don't send an individual nudge — finalizeBatch will pick it up retroactively.
			if (currentBatchAgents.some((a) => a.id === record.id)) {
				widget.update();
				return;
			}

			const result = groupJoin.onAgentComplete(record);
			if (result === "pass") {
				sendIndividualNudge(record);
			}
			// 'held' → do nothing, group will fire later
			// 'delivered' → group callback already fired
			widget.update();
		},
		undefined,
		(record) => {
			recordInProcessUpdate(record);
			// Emit started event when agent transitions to running (including from queue)
			pi.events.emit("subagents:started", {
				id: record.id,
				type: record.type,
				description: record.description,
			});
			if (record.isBackground) {
				widget.ensureTimer();
				widget.update();
			}
		},
		(record, info) => {
			// Emit compacted event when agent's session compacts (preserves count on record).
			pi.events.emit("subagents:compacted", {
				id: record.id,
				type: record.type,
				description: record.description,
				reason: info.reason,
				tokensBefore: info.tokensBefore,
				compactionCount: record.compactionCount,
			});
		},
	);
	const processState = getMosaicProcessState();
	const fullSessionAgents = processState.fullSessionAgents;
	const messageServer = processState.messageServer;
	// Live widget: show running agents above editor.
	const widget = new AgentWidget(manager, agentActivity, listFullSessionWidgetAgents);

	processState.messageUpdateUnsubscribe?.();
	processState.messageUpdateUnsubscribe = messageServer.onUpdate((update) => {
		if (!isNativeCompletionUpdate(update)) return;
		emitFullSessionCompletion(update);
	});

	function ensureMessageTransport(): Promise<MosaicMessageTransport> {
		processState.messageTransport ??= startMosaicMessageTransport(messageServer).catch((error) => {
			processState.messageTransport = undefined;
			throw error;
		});
		return processState.messageTransport;
	}

	function isNativeCompletionUpdate(update: unknown): update is MosaicAgentUpdate {
		if (!update || typeof update !== "object") return false;
		const candidate = update as MosaicAgentUpdate;
		return candidate.type === "agent_update" && (candidate.status === "completed" || candidate.status === "error");
	}

	function emitFullSessionCompletion(update: MosaicAgentUpdate): void {
		if (isMosaicChildSession()) return;
		const fullSession = fullSessionAgents.get(update.agentId);
		if (!fullSession || fullSession.resultDelivered) return;

		fullSession.status = update.status === "error" ? "error" : "completed";
		fullSession.result = update.result;
		fullSession.error = update.error;
		fullSession.completedAt ??= update.createdAt;
		fullSession.resultDelivered = true;

		const activity = agentActivity.get(update.agentId);
		const record: AgentRecord = {
			id: fullSession.id,
			type: fullSession.type,
			description: fullSession.description,
			status: fullSession.status,
			result: fullSession.result,
			error: fullSession.error,
			toolUses: activity?.toolUses ?? 0,
			startedAt: fullSession.startedAt,
			completedAt: fullSession.completedAt,
			isBackground: true,
			worktree: fullSession.worktree,
			modelName: fullSession.modelName,
			thinkingLevel: fullSession.thinkingLevel,
			lifetimeUsage: activity?.lifetimeUsage ?? { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			mosaicIdentity: fullSession.mosaicIdentity,
		};

		agentActivity.delete(update.agentId);
		widget.markFinished(update.agentId);
		pi.sendMessage<NotificationDetails>(
			{
				customType: "subagent-notification",
				content: formatTaskNotification(record, 20_000),
				display: true,
				details: buildNotificationDetails(record, 500, activity),
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		widget.update();
	}

	function currentMosaicOwner(): string | undefined {
		const pane = currentMultiplexerTarget().paneId ?? process.env.TMUX_PANE ?? process.env.ZELLIJ_PANE_ID;
		return pane ? resolveOwner(pane) : undefined;
	}

	function recoverFullSessionAgentsFromHeartbeats(): void {
		if (isMosaicChildSession()) return;
		const owner = currentMosaicOwner();
		if (!owner) return;
		for (const live of muxHeartbeat.listActive()) {
			if (!live.agentId || live.owner !== owner || fullSessionAgents.has(live.agentId)) continue;
			const description = live.agentDescription ?? live.mosaicAgentName ?? live.label ?? live.agentId;
			fullSessionAgents.set(live.agentId, {
				id: live.agentId,
				laneId: live.agentId,
				type: live.agentType ?? "general-purpose",
				description,
				sessionFile: live.sessionFile,
				paneId: live.paneId,
				windowId: live.windowId ?? live.zellijTabId ?? "",
				windowName: live.windowName ?? live.zellijTabName ?? description,
				startedAt: readSessionStartedAt(live.sessionFile) ?? Date.now(),
				status: "running",
				mosaicIdentity:
					live.mosaicAgentLabel && live.mosaicAgentColor
						? { label: live.mosaicAgentLabel, color: live.mosaicAgentColor }
						: undefined,
			});
			agentActivity.set(live.agentId, {
				activeTools: new Map(),
				toolUses: 0,
				turnCount: 1,
				responseText: "recovered from live mosaic pane",
				session: undefined,
				lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			});
		}
	}

	function resolveFullSessionTarget(target: string): string | undefined {
		if (fullSessionAgents.has(target)) return target;
		for (const [id, agent] of fullSessionAgents) {
			if (agent.description === target) return id;
		}
		return undefined;
	}

	function listNativeAndRecoveredAgents(input: { pathPrefix?: string }) {
		recoverFullSessionAgentsFromHeartbeats();
		const nativeAgents = messageServer.listAgents();
		const nativeIds = new Set(nativeAgents.map((agent) => agent.agentId));
		const recovered = [...fullSessionAgents.values()]
			.filter((agent) => !nativeIds.has(agent.id))
			.map((agent) => ({
				agentId: agent.id,
				taskName: agent.description,
				type: agent.type,
				description: agent.description,
				connected: false,
				closed: false,
				status: agent.status === "error" ? "error" : agent.status === "stopped" ? "disconnected" : agent.status,
				lastSeq: messageServer.currentSeq,
				createdAt: agent.startedAt,
				updatedAt: agent.completedAt ?? agent.startedAt,
			}));
		const inProcess = manager.listAgents().map((agent) => ({
			agentId: agent.id,
			taskName: agent.description,
			type: agent.type,
			description: agent.description,
			connected: true,
			closed: agent.status === "stopped",
			status: agent.status,
			runtime: "in-process",
			lastSeq: messageServer.currentSeq,
			createdAt: agent.startedAt,
			updatedAt: agent.completedAt ?? agent.startedAt,
		}));
		const agents = [...nativeAgents, ...recovered, ...inProcess];
		return input.pathPrefix ? agents.filter((agent) => agent.taskName?.startsWith(input.pathPrefix!)) : agents;
	}

	function resolveInProcessTarget(target: string): string | undefined {
		if (manager.getRecord(target)) return target;
		return manager.listAgents().find((agent) => agent.description === target)?.id;
	}

	function refreshFullSessionHud(ui?: UICtx): void {
		if (ui) widget.setUICtx(ui);
		if (isMosaicChildSession()) {
			widget.dispose();
			return;
		}
		recoverFullSessionAgentsFromHeartbeats();
		widget.update();
	}

	interface SpawnAgentInput {
		taskName: string;
		message: string;
		agentType?: string;
		modelPreset?: string;
		model?: string;
		thinking?: string;
		mode?: "full-session" | "in-process";
		runInBackground?: boolean;
		isolation?: "worktree";
		cwd?: string;
		onTextDelta?: (fullText: string, metadata?: { modelName?: string; thinkingLevel?: string }) => void;
	}

	function resolveAgentType(agentType: string | undefined): {
		subagentType: SubagentType;
		customConfig: AgentConfig | undefined;
	} {
		reloadCustomAgents();
		const rawType = agentType ?? "general-purpose";
		const subagentType = resolveType(rawType) ?? "general-purpose";
		return { subagentType, customConfig: getAgentConfig(subagentType) };
	}

	function resolveExplicitSelection(input: SpawnAgentInput): {
		model?: any;
		thinking?: AgentRecord["thinkingLevel"];
	} {
		if (!currentCtx) throw new Error("No active session");
		if (input.model) {
			const resolved = resolveModel(input.model, currentCtx.modelRegistry as ModelRegistry);
			if (typeof resolved === "string") throw new Error(resolved);
			return { model: resolved, thinking: input.thinking as AgentRecord["thinkingLevel"] };
		}
		if (input.modelPreset) {
			const resolved = resolveModelPreset(
				input.modelPreset,
				currentCtx.modelRegistry as ModelRegistry,
				allModelPresets(),
			);
			return {
				model: resolved.model,
				thinking: (input.thinking as AgentRecord["thinkingLevel"] | undefined) ?? resolved.thinking,
			};
		}
		return { thinking: input.thinking as AgentRecord["thinkingLevel"] | undefined };
	}

	function resolveAgentRunDisplay(
		customConfig: AgentConfig | undefined,
		explicit: { model?: any; thinking?: AgentRecord["thinkingLevel"] },
	): { modelName?: string; thinkingLevel?: AgentRecord["thinkingLevel"] } {
		if (!currentCtx) throw new Error("No active session");
		const registry = currentCtx.modelRegistry as ModelRegistry;
		const preset = resolveModelPreset(customConfig?.modelPreset, registry, allModelPresets());
		const configuredModel = resolveConfiguredModel(customConfig?.model, registry);
		const effectiveModel = explicit.model ?? configuredModel ?? preset.model ?? currentCtx.model;
		return {
			modelName: modelLabelFromModel(effectiveModel),
			thinkingLevel: explicit.thinking ?? customConfig?.thinking ?? preset.thinking,
		};
	}

	async function spawnAgent(input: SpawnAgentInput) {
		const { customConfig } = resolveAgentType(input.agentType);
		const mode = input.mode ?? "in-process";
		if (mode === "full-session") return spawnFullSessionAgent(input);
		return spawnInProcessAgent({
			...input,
			mode,
			runInBackground: input.runInBackground ?? customConfig?.runInBackground ?? false,
		});
	}

	async function spawnFullSessionAgent(input: SpawnAgentInput) {
		if (!currentCtx) throw new Error("No active session");
		if (!hasMultiplexer()) throw new Error("mosaic requires tmux or an active zellij session");
		const agentCwd = resolveAgentCwd(input.cwd, currentCtx.cwd);
		const { subagentType, customConfig } = resolveAgentType(input.agentType);
		const explicit = resolveExplicitSelection(input);
		const runDisplay = resolveAgentRunDisplay(customConfig, explicit);
		const plannedId = randomUUID().slice(0, 17);
		const transport = await ensureMessageTransport();
		const startedAt = Date.now();
		const connection = messageServer.registerAgent({
			agentId: plannedId,
			taskName: input.taskName,
			type: subagentType,
			description: input.taskName,
		});
		let launched: Awaited<ReturnType<typeof launchFullSessionAgent>>;
		try {
			launched = await launchFullSessionAgent(pi, currentCtx, {
				id: plannedId,
				type: subagentType,
				description: input.taskName,
				prompt: input.message,
				model: explicit.model as any,
				thinkingLevel: explicit.thinking as any,
				isolation: input.isolation,
				cwd: agentCwd,
				agentConfig: customConfig,
				messageEndpoint: transport.endpoint,
				messageToken: connection.token,
			});
		} catch (error) {
			messageServer.removeAgent(plannedId);
			throw error;
		}
		fullSessionAgents.set(launched.id, {
			id: launched.id,
			laneId: launched.laneId,
			type: subagentType,
			description: input.taskName,
			sessionFile: launched.sessionFile,
			paneId: launched.paneId,
			windowId: launched.windowId,
			windowName: launched.windowName,
			cwd: launched.cwd,
			startedAt,
			status: "running",
			worktree: launched.worktree,
			placement: launched.placement,
			mosaicIdentity: launched.mosaicIdentity,
			modelName: runDisplay.modelName,
			thinkingLevel: runDisplay.thinkingLevel,
		});
		agentActivity.set(launched.id, {
			activeTools: new Map(),
			toolUses: 0,
			turnCount: 1,
			responseText: "starting mosaic target",
			session: undefined,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		});
		refreshFullSessionHud((currentCtx as { ui?: UICtx }).ui);
		pi.events.emit("subagents:created", {
			id: launched.id,
			type: subagentType,
			description: input.taskName,
			isBackground: true,
			sessionFile: launched.sessionFile,
			paneId: launched.paneId,
			windowId: launched.windowId,
			windowName: launched.windowName,
		});
		return { agentId: launched.id, taskName: input.taskName, seq: messageServer.currentSeq };
	}

	async function spawnInProcessAgent(input: SpawnAgentInput) {
		if (!currentCtx) throw new Error("No active session");
		const agentCwd = resolveAgentCwd(input.cwd, currentCtx.cwd);
		const { subagentType, customConfig } = resolveAgentType(input.agentType);
		const explicit = resolveExplicitSelection(input);
		const runDisplay = resolveAgentRunDisplay(customConfig, explicit);
		const options = {
			description: input.taskName,
			modelName: runDisplay.modelName,
			model: explicit.model as any,
			thinkingLevel: runDisplay.thinkingLevel,
			isolation: input.isolation,
			cwd: agentCwd,
		};

		if (input.runInBackground === false) {
			const id = manager.spawn(pi, currentCtx, subagentType, input.message, {
				...options,
				isBackground: false,
				signal: currentCtx.signal,
				onTextDelta: (_delta, fullText) =>
					input.onTextDelta?.(fullText, {
						modelName: runDisplay.modelName,
						thinkingLevel: runDisplay.thinkingLevel,
					}),
			});
			activeInlineAgentId = id;
			const record = manager.getRecord(id)!;
			try {
				await record.promise;
			} finally {
				if (activeInlineAgentId === id) activeInlineAgentId = undefined;
			}
			record.resultConsumed = true;
			return {
				agentId: record.id,
				taskName: input.taskName,
				runtime: "in-process",
				background: false,
				status: record.status,
				result: record.result,
				error: record.error,
				modelName: record.modelName,
				thinkingLevel: record.thinkingLevel,
			};
		}

		const activity: AgentActivity = {
			activeTools: new Map(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			session: undefined,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		};
		const id = manager.spawn(pi, currentCtx, subagentType, input.message, {
			...options,
			isBackground: true,
			onToolActivity: (toolActivity) => {
				if (toolActivity.type === "start") {
					activity.activeTools.set(toolActivity.toolName, toolActivity.toolName);
				} else {
					activity.activeTools.delete(toolActivity.toolName);
					activity.toolUses++;
				}
				widget.update();
			},
			onTextDelta: (_delta, fullText) => {
				activity.responseText = fullText;
				widget.update();
			},
			onTurnEnd: (turnCount) => {
				activity.turnCount = turnCount;
				widget.update();
			},
			onAssistantUsage: (usage) => {
				addUsage(activity.lifetimeUsage, usage);
				widget.update();
			},
			onSessionCreated: (session) => {
				activity.session = session;
				widget.update();
			},
		});
		agentActivity.set(id, activity);
		pi.events.emit("subagents:created", {
			id,
			type: subagentType,
			description: input.taskName,
			isBackground: true,
			runtime: "in-process",
		});
		widget.ensureTimer();
		widget.update();
		return { agentId: id, taskName: input.taskName, runtime: "in-process", background: true };
	}

	for (const tool of createMosaicTools({
		onToolContext: (toolCtx) => {
			const ui = (toolCtx as { ui?: UICtx } | undefined)?.ui;
			if (ui) {
				widget.setUICtx(ui);
				widget.onTurnStart();
				refreshFullSessionHud(ui);
			}
		},
		spawnAgent,
		sendMessage: async (input) => {
			try {
				return messageServer.enqueueMessage(input.target, {
					body: input.message,
					triggerTurn: input.triggerTurn,
				});
			} catch (error) {
				const inProcessId = resolveInProcessTarget(input.target);
				if (inProcessId) {
					const record = manager.getRecord(inProcessId);
					if (record) return deliverInProcessMessage(record, input);
				}
				if (resolveFullSessionTarget(input.target)) {
					throw new Error(
						`agent is visible after reload but its native mailbox is not attached: ${input.target}`,
						{ cause: error },
					);
				}
				throw error;
			}
		},
		waitAgent: async (input) => waitForAnyAgentUpdate(input),
		listAgents: async (input) => listNativeAndRecoveredAgents(input),
		closeAgent: async (input) => {
			try {
				const update = messageServer.closeAgent(input.target);
				const live = muxHeartbeat.listActive().find((entry) => entry.agentId === update.agentId);
				if (live) cleanupFullSessionAgentPane(update.agentId, live);
				return update;
			} catch (error) {
				const recoveredId = resolveFullSessionTarget(input.target);
				if (!recoveredId) {
					const inProcessId = resolveInProcessTarget(input.target);
					if (!inProcessId) throw error;
					manager.abort(inProcessId);
					const record = manager.getRecord(inProcessId);
					if (record) return recordInProcessUpdate(record);
					return {
						type: "agent_update",
						seq: inProcessSeq,
						agentId: inProcessId,
						status: "closed",
						createdAt: Date.now(),
					};
				}
				cleanupFullSessionAgentPane(recoveredId);
				return {
					type: "agent_update",
					seq: messageServer.currentSeq,
					agentId: recoveredId,
					status: "closed",
					createdAt: Date.now(),
				};
			}
		},
	})) {
		pi.registerTool(tool);
	}

	function listFullSessionWidgetAgents(): AgentRecord[] {
		if (isMosaicChildSession()) return [];
		recoverFullSessionAgentsFromHeartbeats();
		const liveByAgentId = new Map(
			muxHeartbeat
				.listActive()
				.filter((entry) => entry.agentId)
				.map((entry) => [entry.agentId!, entry]),
		);
		const records: AgentRecord[] = [];
		for (const [id, fullSession] of fullSessionAgents) {
			const live = liveByAgentId.get(id);
			const activity =
				agentActivity.get(id) ??
				({
					activeTools: new Map<string, string>(),
					toolUses: 0,
					turnCount: 1,
					maxTurns: fullSession.maxTurns,
					responseText: "",
					session: undefined,
					lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
				} satisfies AgentActivity);
			const transcript = readSessionTranscriptSnapshot(fullSession.sessionFile, false);
			let status: FullSessionAgentRecord["status"] = fullSession.status;
			const resolved = resolveFullSessionAgentStatus({
				currentStatus: fullSession.status,
				live: live ? { busy: live.busy } : undefined,
				transcript,
				now: Date.now(),
			});
			status = resolved.status;
			fullSession.result = resolved.result;
			fullSession.error = resolved.error;
			if (status === "running") {
				fullSession.completedAt = undefined;
			} else {
				fullSession.completedAt ??= resolved.completedAt ?? Date.now();
			}
			if (fullSession.status !== status && status !== "running") {
				widget.markFinished(id);
			}
			fullSession.status = status;
			if ((status === "completed" || status === "error") && live?.backend === "zellij" && live.zellijSessionOwned) {
				try {
					killTarget(live);
				} catch {
					/* ignore cleanup failures; transcript/result remains accessible */
				}
			}
			activity.maxTurns = fullSession.maxTurns;
			activity.responseText = resolved.activityText;
			agentActivity.set(id, activity);
			const mosaicIdentity = resolveMosaicWidgetIdentity(live, fullSession);
			records.push({
				id,
				type: fullSession.type,
				description: fullSession.description,
				status,
				result: fullSession.result,
				error: fullSession.error,
				toolUses: activity.toolUses,
				startedAt: fullSession.startedAt,
				completedAt: fullSession.completedAt,
				isBackground: true,
				worktree: fullSession.worktree,
				modelName: fullSession.modelName,
				thinkingLevel: fullSession.thinkingLevel,
				lifetimeUsage: activity.lifetimeUsage,
				compactionCount: 0,
				mosaicIdentity,
			});
		}
		return records;
	}

	function resolveMosaicWidgetIdentity(
		live: muxHeartbeat.Heartbeat | undefined,
		fullSession: FullSessionAgentRecord,
	): AgentRecord["mosaicIdentity"] {
		const label = live?.mosaicAgentLabel ?? fullSession.mosaicIdentity?.label;
		const color = mosaicIdentityColor(label) ?? live?.mosaicAgentColor ?? fullSession.mosaicIdentity?.color;
		if (!label || !color) return undefined;
		return { label, color };
	}

	function mosaicIdentityColor(label: string | undefined): string | undefined {
		const match = label?.match(/^A(\d+)$/);
		if (!match) return undefined;
		const index = Number(match[1]);
		if (!Number.isFinite(index) || index <= 0) return undefined;
		const colors = ["f38ba8", "fab387", "f9e2af", "eba0ac", "e78284", "ff9e64", "ffc777", "ff757f"];
		return colors[(index - 1) % colors.length];
	}

	function cleanupFullSessionAgentPane(agentId: string, live?: muxHeartbeat.Heartbeat): void {
		const target = live ?? muxHeartbeat.listActive().find((entry) => entry.agentId === agentId);
		if (target) {
			try {
				killTarget(target);
			} catch {
				/* Pane may already be gone; cleanup should be idempotent. */
			}
		}
		fullSessionAgents.delete(agentId);
		agentActivity.delete(agentId);
		widget.markFinished(agentId);
		widget.update();
	}

	// Expose manager via Symbol.for() global registry for cross-package access.
	// Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
	const MANAGER_KEY = Symbol.for("mosaic:manager");
	(globalThis as any)[MANAGER_KEY] = {
		waitForAll: () => manager.waitForAll(),
		hasRunning: () => manager.hasBlockingRunning(),
		hasBackgroundRunning: () => manager.hasRunning(),
		spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
			manager.spawn(piRef, ctx, type, prompt, options),
		getRecord: (id: string) => manager.getRecord(id),
	};

	// --- Cross-extension RPC via pi.events ---
	let currentCtx: ExtensionContext | undefined;
	let activeInlineAgentId: string | undefined;

	// ---- Subagent scheduler ----
	// Session-scoped: store is constructed inside session_start once sessionId
	// is available. Mirrors pi-chonky-tasks's session-scoped task store —
	// schedules reset on /new, restore on /resume.
	const scheduler = new SubagentScheduler();

	function startScheduler(ctx: ExtensionContext) {
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (!sessionId) return; // sessionId not yet available — try again on next event
			const path = resolveStorePath(ctx.cwd, sessionId);
			const store = new ScheduleStore(path);
			scheduler.start(pi, ctx, manager, store);
			pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
		} catch (err) {
			// Scheduling is non-essential — log and move on so the rest of the
			// extension keeps working if e.g. .pi/ is unwritable.
			console.warn("[mosaic] Failed to start scheduler:", err);
		}
	}

	// Capture ctx from session_start for RPC spawn handler + start the scheduler.
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		refreshFullSessionHud(ctx.ui as UICtx);
		manager.clearCompleted();
		if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
	});

	pi.on("input", async (event) => {
		if (!activeInlineAgentId) return { action: "continue" };
		if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
		if (event.text.trimStart().startsWith("/")) return { action: "continue" };
		const record = manager.getRecord(activeInlineAgentId);
		if (!record || record.status !== "running") return { action: "continue" };
		await deliverInProcessMessage(record, { message: event.text, triggerTurn: true });
		return { action: "handled" };
	});

	pi.on("session_before_switch", () => {
		manager.clearCompleted();
		scheduler.stop();
	});

	const {
		unsubPing: unsubPingRpc,
		unsubSpawn: unsubSpawnRpc,
		unsubStop: unsubStopRpc,
	} = registerRpcHandlers({
		events: pi.events,
		pi,
		getCtx: () => currentCtx,
		manager,
	});

	// Broadcast readiness so extensions loaded after us can discover us
	pi.events.emit("subagents:ready", {});

	// On shutdown, abort all agents immediately and clean up.
	// If the session is going down, there's nothing left to consume agent results.
	pi.on("session_shutdown", async () => {
		unsubSpawnRpc();
		unsubStopRpc();
		unsubPingRpc();
		processState.messageUpdateUnsubscribe?.();
		processState.messageUpdateUnsubscribe = undefined;
		currentCtx = undefined;
		delete (globalThis as any)[MANAGER_KEY];
		scheduler.stop();
		manager.abortAll();
		for (const timer of pendingNudges.values()) clearTimeout(timer);
		pendingNudges.clear();
		widget.dispose();
		manager.dispose();
	});

	// ---- Join mode configuration ----
	let defaultJoinMode: JoinMode = "smart";
	function getDefaultJoinMode(): JoinMode {
		return defaultJoinMode;
	}
	function setDefaultJoinMode(mode: JoinMode) {
		defaultJoinMode = mode;
	}

	// Master switch for the schedule subagent feature. Defaults to enabled.
	// Read once at extension init so runtime toggles via /mosaic settings
	// → Settings short-circuit the menu entry + the execute-time addJob path
	// immediately, but the schema-level removal only takes effect on next
	// extension load (next pi session). Documented in CHANGELOG/README.
	let schedulingEnabled = true;
	function isSchedulingEnabled(): boolean {
		return schedulingEnabled;
	}
	function setSchedulingEnabled(b: boolean) {
		schedulingEnabled = b;
	}

	// ---- Batch tracking for smart join mode ----
	// Collects background agent IDs spawned in the current turn for smart grouping.
	// Uses a debounced timer: each new agent resets the 100ms window so that all
	// parallel tool calls (which may be dispatched across multiple microtasks by the
	// framework) are captured in the same batch.
	let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
	let _batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
	let batchCounter = 0;

	/** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
	function _finalizeBatch() {
		_batchFinalizeTimer = undefined;
		const batchAgents = [...currentBatchAgents];
		currentBatchAgents = [];

		const smartAgents = batchAgents.filter((a) => a.joinMode === "smart" || a.joinMode === "group");
		if (smartAgents.length >= 2) {
			const groupId = `batch-${++batchCounter}`;
			const ids = smartAgents.map((a) => a.id);
			groupJoin.registerGroup(groupId, ids);
			// Retroactively process agents that already completed during the debounce window.
			// Their onComplete fired but was deferred (agent was in currentBatchAgents),
			// so we feed them into the group now.
			for (const id of ids) {
				const record = manager.getRecord(id);
				if (!record) continue;
				record.groupId = groupId;
				if (record.completedAt != null && !record.resultConsumed) {
					groupJoin.onAgentComplete(record);
				}
			}
		} else {
			// No group formed — send individual nudges for any agents that completed
			// during the debounce window and had their notification deferred.
			for (const { id } of batchAgents) {
				const record = manager.getRecord(id);
				if (record?.completedAt != null && !record.resultConsumed) {
					sendIndividualNudge(record);
				}
			}
		}
	}

	// Grab UI context from first tool execution + clear lingering widget on new turn
	pi.on("tool_execution_start", async (_event, ctx) => {
		widget.setUICtx(ctx.ui as UICtx);
		widget.onTurnStart();
	});

	/** Derive a short model label from a model string. */
	function getModelLabelFromConfig(model: string): string {
		// Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
		const name = model.includes("/") ? model.split("/").pop()! : model;
		// Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
		return name.replace(/-\d{8}$/, "");
	}

	function modelLabelFromModel(model: any): string | undefined {
		const raw = typeof model?.name === "string" && model.name.trim() ? model.name : model?.id;
		return typeof raw === "string" && raw.trim() ? getModelLabelFromConfig(raw.trim()) : undefined;
	}

	let customModelPresets: Record<string, ModelPresetCandidate[]> = {};

	function allModelPresets(): Record<string, ModelPresetCandidate[]> {
		return mergeModelPresets(customModelPresets);
	}

	// Apply persisted settings on startup and emit `subagents:settings_loaded`.
	// Global + project merged; missing → defaults; corrupt file emits a warning
	// to stderr and falls back to defaults.
	const loadedSettings = applyAndEmitLoaded(
		{
			setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
			setDefaultMaxTurns,
			setGraceTurns,
			setDefaultJoinMode,
			setSchedulingEnabled,
		},
		(event, payload) => pi.events.emit(event, payload),
	);
	customModelPresets = loadedSettings.modelPresets ?? {};

	// ---- /mosaic settings interactive menu ----

	const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
	const personalAgentsDir = () => join(getAgentDir(), "agents");

	/** Find the file path of a custom agent by name (project first, then global). */
	function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
		const projectPath = join(projectAgentsDir(), `${name}.md`);
		if (existsSync(projectPath)) return { path: projectPath, location: "project" };
		const personalPath = join(personalAgentsDir(), `${name}.md`);
		if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
		return undefined;
	}

	function getModelLabel(type: string, registry?: ModelRegistry): string {
		const cfg = getAgentConfig(type);
		if (!cfg) return "inherit";
		if (cfg.modelPreset) {
			if (registry) {
				const resolved = resolveModelPreset(cfg.modelPreset, registry, allModelPresets());
				if (!resolved.model) return `${cfg.modelPreset} unavailable`;
			}
			return cfg.modelPreset;
		}
		if (!cfg.model) return "inherit";
		// If registry provided, check if the model actually resolves
		if (registry) {
			const resolved = resolveModel(cfg.model, registry);
			if (typeof resolved === "string") return `custom ${getModelLabelFromConfig(cfg.model)} unavailable`;
		}
		return `custom ${getModelLabelFromConfig(cfg.model)}`;
	}

	function modelKey(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	function scopedModelsFromSettings(ctx: ExtensionCommandContext): Array<{ model: unknown }> {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir());
		const patterns = settings.getEnabledModels();
		if (!patterns?.length) return [];

		const scoped: Array<{ model: unknown }> = [];
		const seen = new Set<string>();
		for (const pattern of patterns) {
			const resolved = resolveModel(pattern, ctx.modelRegistry as ModelRegistry);
			if (typeof resolved === "string") continue;
			const key = modelKey(resolved);
			if (seen.has(key)) continue;
			seen.add(key);
			scoped.push({ model: resolved });
		}
		return scoped;
	}

	async function pickAvailableModel(
		ctx: ExtensionCommandContext,
		_title: string,
		currentModelRef?: string,
	): Promise<string | undefined> {
		const currentConfigured = currentModelRef
			? resolveModel(currentModelRef, ctx.modelRegistry as ModelRegistry)
			: undefined;
		return ctx.ui.custom<string | undefined>(
			(tui, _theme, _keybindings, done) => {
				const selector = new ModelSelectorComponent(
					tui,
					typeof currentConfigured === "string" ? ctx.model : ((currentConfigured as any) ?? ctx.model),
					SettingsManager.inMemory(),
					ctx.modelRegistry as any,
					scopedModelsFromSettings(ctx) as any,
					(model: any) => done(modelKey(model)),
					() => done(undefined),
				);
				tui.setFocus(selector);
				return selector;
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "90%" } },
		);
	}

	async function pickCandidateThinking(
		ctx: ExtensionCommandContext,
		title: string,
		current?: string,
	): Promise<string | undefined | null> {
		const options = [`none (current: ${current ?? "none"})`, "off", "minimal", "low", "medium", "high", "xhigh"];
		const choice = await ctx.ui.select(title, options);
		if (!choice) return null;
		return choice.startsWith("none ") ? undefined : choice;
	}

	function buildAgentMarkdownContent(
		cfg: AgentConfig,
		overrides: Partial<Pick<AgentConfig, "modelPreset" | "model" | "thinking">> = {},
	): string {
		const hasOverride = (key: keyof typeof overrides) => Object.hasOwn(overrides, key);
		const modelPreset = hasOverride("modelPreset") ? overrides.modelPreset : cfg.modelPreset;
		const model = hasOverride("model") ? overrides.model : cfg.model;
		const thinking = hasOverride("thinking") ? overrides.thinking : cfg.thinking;
		const fmFields: string[] = [];
		fmFields.push(`description: ${cfg.description}`);
		if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
		if (cfg.toolNames) {
			fmFields.push(`tools: ${cfg.toolNames.length > 0 ? cfg.toolNames.join(", ") : "none"}`);
		}
		if (modelPreset) fmFields.push(`model_preset: ${modelPreset}`);
		if (model) fmFields.push(`model: ${model}`);
		if (thinking) fmFields.push(`thinking: ${thinking}`);
		if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
		fmFields.push(`prompt_mode: ${cfg.promptMode}`);
		if (cfg.extensions === false) fmFields.push("extensions: false");
		else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
		if (cfg.skills === false) fmFields.push("skills: false");
		else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
		if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
		if (cfg.inheritContext) fmFields.push("inherit_context: true");
		if (cfg.runInBackground) fmFields.push("run_in_background: true");
		if (cfg.isolated) fmFields.push("isolated: true");
		if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
		if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);
		if (cfg.enabled === false) fmFields.push("enabled: false");
		return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
	}

	async function chooseAgentFileForUpdate(
		ctx: ExtensionCommandContext,
		name: string,
		cfg: AgentConfig,
		overrides: Partial<Pick<AgentConfig, "modelPreset" | "model" | "thinking">>,
	): Promise<string | undefined> {
		const file = findAgentFile(name);
		if (file) return file.path;

		const location = await ctx.ui.select("Choose location", [
			"Project (.pi/agents/)",
			`Personal (${personalAgentsDir()})`,
		]);
		if (!location) return undefined;

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
		mkdirSync(targetDir, { recursive: true });
		const targetPath = join(targetDir, `${name}.md`);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(targetPath, buildAgentMarkdownContent(cfg, overrides), "utf-8");
		return targetPath;
	}

	function updateFrontmatterField(content: string, key: string, value: string | undefined): string {
		const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		const lines = match ? match[1].split("\n") : [];
		const body = match ? match[2] : content;
		const nextLines = lines.filter((line) => !line.match(new RegExp(`^\\s*${key}\\s*:`)));
		if (value) nextLines.push(`${key}: ${value}`);
		return `---\n${nextLines.join("\n")}\n---\n${body ? (body.startsWith("\n") ? body : `\n${body}`) : ""}`;
	}

	async function setAgentFrontmatterField(
		ctx: ExtensionCommandContext,
		name: string,
		cfg: AgentConfig,
		key: "thinking",
		value: string | undefined,
	) {
		const path = await chooseAgentFileForUpdate(ctx, name, cfg, { [key]: value });
		if (!path) return;

		const existing = readFileSync(path, "utf-8");
		const updated = updateFrontmatterField(existing, key, value);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, updated, "utf-8");
		reloadCustomAgents();
		ctx.ui.notify(`${name} ${key} set to ${value ?? "inherit"} (${path})`, "info");
	}

	async function setAgentModelPreset(
		ctx: ExtensionCommandContext,
		name: string,
		cfg: AgentConfig,
		presetName: string | undefined,
	) {
		const path = await chooseAgentFileForUpdate(ctx, name, cfg, { modelPreset: presetName, model: undefined });
		if (!path) return;

		const existing = readFileSync(path, "utf-8");
		let updated = updateFrontmatterField(existing, "model_preset", presetName);
		updated = updateFrontmatterField(updated, "model", undefined);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, updated, "utf-8");
		reloadCustomAgents();
		ctx.ui.notify(`${name} model preset set to ${presetName ?? "inherit"} (${path})`, "info");
	}

	async function configureAgentModelPreset(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
		const presets = allModelPresets();
		const presetNames = orderedModelPresetNames(customModelPresets);
		const current = getModelLabel(name, ctx.modelRegistry);
		const options = [
			`Inherit parent model (current: ${current})`,
			...presetNames.map((presetName) => {
				const source = Object.hasOwn(customModelPresets, presetName) ? "custom" : "default";
				return `${presetName} [${source}] — ${formatModelPresetCandidates(presets[presetName] ?? [])}`;
			}),
		];
		const choice = await ctx.ui.select(`Model preset for ${name}`, options);
		if (!choice) return;
		if (choice.startsWith("Inherit parent model")) {
			await setAgentModelPreset(ctx, name, cfg, undefined);
			return;
		}
		const presetName = presetNames.find((entry) => choice.startsWith(`${entry} [`));
		if (!presetName) return;
		await setAgentModelPreset(ctx, name, cfg, presetName);
	}

	async function configureAgentThinking(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
		const current = cfg.thinking ?? (cfg.modelPreset ? "preset" : "inherit");
		const options = [
			`Inherit model/default thinking (current: ${current})`,
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		];
		const choice = await ctx.ui.select(`Thinking for ${name}`, options);
		if (!choice) return;

		const value = choice.startsWith("Inherit model/default thinking") ? undefined : choice;
		await setAgentFrontmatterField(ctx, name, cfg, "thinking", value);
	}

	function customPresetSnapshot(): Record<string, ModelPresetCandidate[]> | undefined {
		return Object.keys(customModelPresets).length > 0 ? customModelPresets : undefined;
	}

	function saveModelPresets(
		ctx: ExtensionCommandContext,
		next: Record<string, ModelPresetCandidate[]>,
		message: string,
	): void {
		customModelPresets = next;
		notifyApplied(ctx, message);
	}

	function savePresetCandidates(
		ctx: ExtensionCommandContext,
		name: string,
		candidates: ModelPresetCandidate[],
		message: string,
	): void {
		saveModelPresets(ctx, { ...customModelPresets, [name]: candidates }, message);
	}

	async function addPresetCandidate(
		ctx: ExtensionCommandContext,
		presetName: string,
		candidates: ModelPresetCandidate[],
	): Promise<void> {
		const model = await pickAvailableModel(ctx, `Candidate model for ${presetName}`);
		if (!model) return;
		const thinking = await pickCandidateThinking(ctx, `Thinking for ${presetName} candidate`);
		if (thinking === null) return;
		savePresetCandidates(
			ctx,
			presetName,
			[...candidates, thinking ? { model, thinking: thinking as any } : { model }],
			`Saved model preset ${presetName}`,
		);
	}

	async function showPresetCandidateDetail(
		ctx: ExtensionCommandContext,
		presetName: string,
		candidates: ModelPresetCandidate[],
		index: number,
	): Promise<void> {
		const candidate = candidates[index];
		if (!candidate) return;
		const options = [
			`Change model (${candidate.model})`,
			`Change thinking (${candidate.thinking ?? "none"})`,
			...(index > 0 ? ["Move earlier"] : []),
			...(index < candidates.length - 1 ? ["Move later"] : []),
			...(candidates.length > 1 ? ["Remove candidate"] : []),
			"Back",
		];
		const choice = await ctx.ui.select(`${presetName} candidate ${index + 1}`, options);
		if (!choice || choice === "Back") return;

		if (choice.startsWith("Change model")) {
			const model = await pickAvailableModel(ctx, `Candidate model for ${presetName}`, candidate.model);
			if (!model) return;
			const next = candidates.map((entry, i) => (i === index ? { ...entry, model } : entry));
			savePresetCandidates(ctx, presetName, next, `Saved model preset ${presetName}`);
			return;
		}

		if (choice.startsWith("Change thinking")) {
			const thinking = await pickCandidateThinking(ctx, `Thinking for ${presetName} candidate`, candidate.thinking);
			if (thinking === null) return;
			const next = candidates.map((entry, i) => {
				if (i !== index) return entry;
				return thinking ? { ...entry, thinking: thinking as any } : { model: entry.model };
			});
			savePresetCandidates(ctx, presetName, next, `Saved model preset ${presetName}`);
			return;
		}

		if (choice === "Move earlier") {
			const next = [...candidates];
			[next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
			savePresetCandidates(ctx, presetName, next, `Saved model preset ${presetName}`);
			return;
		}

		if (choice === "Move later") {
			const next = [...candidates];
			[next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
			savePresetCandidates(ctx, presetName, next, `Saved model preset ${presetName}`);
			return;
		}

		if (choice === "Remove candidate") {
			const next = candidates.filter((_, i) => i !== index);
			savePresetCandidates(ctx, presetName, next, `Saved model preset ${presetName}`);
		}
	}

	async function showModelPresetDetail(ctx: ExtensionCommandContext, name: string): Promise<void> {
		const merged = allModelPresets();
		const candidates = merged[name];
		if (!candidates) return;
		const hasCustomOverride = Object.hasOwn(customModelPresets, name);
		const isDefaultPreset = isDefaultModelPreset(name);
		const options = [
			...candidates.map(
				(candidate, index) =>
					`${index + 1}. ${candidate.model}${candidate.thinking ? `:${candidate.thinking}` : ""}`,
			),
			"Add candidate",
			hasCustomOverride ? (isDefaultPreset ? "Reset to default" : "Delete preset") : "Back",
		];
		const choice = await ctx.ui.select(`${name} preset`, options);
		if (!choice || choice === "Back") return;

		if (choice === "Add candidate") {
			await addPresetCandidate(ctx, name, candidates);
			return;
		}

		const candidateIndex = options.indexOf(choice);
		if (candidateIndex >= 0 && candidateIndex < candidates.length) {
			await showPresetCandidateDetail(ctx, name, candidates, candidateIndex);
			return;
		}

		if (choice === "Reset to default") {
			const { [name]: _, ...rest } = customModelPresets;
			saveModelPresets(ctx, rest, `Reset model preset ${name} to default`);
			return;
		}

		if (choice === "Delete preset") {
			const { [name]: _, ...rest } = customModelPresets;
			saveModelPresets(ctx, rest, `Deleted model preset ${name}`);
		}
	}

	async function addModelPreset(ctx: ExtensionCommandContext): Promise<void> {
		const name = await ctx.ui.input("Preset name");
		if (!name?.trim()) return;
		const presetName = name.trim();
		const model = await pickAvailableModel(ctx, `First candidate for ${presetName}`);
		if (!model) return;
		const thinking = await pickCandidateThinking(ctx, `Thinking for ${presetName} candidate`);
		if (thinking === null) return;
		savePresetCandidates(
			ctx,
			presetName,
			[thinking ? { model, thinking: thinking as any } : { model }],
			`Saved model preset ${presetName}`,
		);
	}

	async function showModelPresetsMenu(ctx: ExtensionCommandContext): Promise<void> {
		const merged = allModelPresets();
		const presetNames = orderedModelPresetNames(customModelPresets);
		const options = presetNames.map((name) => {
			const source = Object.hasOwn(customModelPresets, name)
				? isDefaultModelPreset(name)
					? "override"
					: "custom"
				: "default";
			return `${name} [${source}] — ${formatModelPresetCandidates(merged[name] ?? [])}`;
		});
		options.push("Add preset");

		const choice = await ctx.ui.select("Model presets", options);
		if (!choice) return;
		if (choice === "Add preset") {
			await addModelPreset(ctx);
			await showModelPresetsMenu(ctx);
			return;
		}
		const presetName = presetNames.find((name) => choice.startsWith(`${name} [`));
		if (!presetName) return;
		await showModelPresetDetail(ctx, presetName);
		await showModelPresetsMenu(ctx);
	}

	async function showAgentsMenu(ctx: ExtensionCommandContext) {
		reloadCustomAgents();
		const allNames = getAllTypes();

		// Build select options
		const options: string[] = [];

		// Running agents entry (only if there are active agents)
		const agents = manager.listAgents();
		if (agents.length > 0) {
			const running = agents.filter((a) => a.status === "running" || a.status === "queued").length;
			const done = agents.filter((a) => a.status === "completed" || a.status === "steered").length;
			options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
		}

		// Agent types list
		if (allNames.length > 0) {
			options.push(`Agent types (${allNames.length})`);
		}

		options.push(`Model presets (${orderedModelPresetNames(customModelPresets).length})`);

		// Scheduled jobs entry (always present when scheduler is active)
		if (scheduler.isActive()) {
			const jobCount = scheduler.list().length;
			options.push(`Scheduled jobs (${jobCount})`);
		}

		// Actions
		options.push("Create new agent");
		options.push("Settings");

		const noAgentsMsg =
			allNames.length === 0 && agents.length === 0
				? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
					"Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
					"Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
				: "";

		if (noAgentsMsg) {
			ctx.ui.notify(noAgentsMsg, "info");
		}

		const choice = await ctx.ui.select("Mosaic Settings", options);
		if (!choice) return;

		if (choice.startsWith("Running agents (")) {
			await showRunningAgents(ctx);
			await showAgentsMenu(ctx);
		} else if (choice.startsWith("Agent types (")) {
			await showAllAgentsList(ctx);
			await showAgentsMenu(ctx);
		} else if (choice.startsWith("Model presets (")) {
			await showModelPresetsMenu(ctx);
			await showAgentsMenu(ctx);
		} else if (choice.startsWith("Scheduled jobs (")) {
			await showSchedulesMenu(ctx, scheduler);
			await showAgentsMenu(ctx);
		} else if (choice === "Create new agent") {
			await showCreateWizard(ctx);
		} else if (choice === "Settings") {
			await showSettings(ctx);
			await showAgentsMenu(ctx);
		}
	}

	async function showAllAgentsList(ctx: ExtensionCommandContext) {
		const allNames = getAllTypes();
		if (allNames.length === 0) {
			ctx.ui.notify("No agents.", "info");
			return;
		}

		// Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
		// Disabled agents get ✕ prefix
		const sourceIndicator = (cfg: AgentConfig | undefined) => {
			const disabled = cfg?.enabled === false;
			if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
			if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
			if (disabled) return "✕  ";
			return "   ";
		};

		const entries = allNames.map((name) => {
			const cfg = getAgentConfig(name);
			const disabled = cfg?.enabled === false;
			const model = getModelLabel(name, ctx.modelRegistry);
			const indicator = sourceIndicator(cfg);
			const prefix = `${indicator}${name} · ${model}`;
			const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
			return { name, prefix, desc };
		});
		const maxPrefix = Math.max(...entries.map((e) => e.prefix.length));

		const hasCustom = allNames.some((n) => {
			const c = getAgentConfig(n);
			return c && !c.isDefault && c.enabled !== false;
		});
		const hasDisabled = allNames.some((n) => getAgentConfig(n)?.enabled === false);
		const legendParts: string[] = [];
		if (hasCustom) legendParts.push("• = project  ◦ = global");
		if (hasDisabled) legendParts.push("✕ = disabled");
		const legend = legendParts.length ? `\n${legendParts.join("  ")}` : "";

		const options = entries.map(({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`);
		if (legend) options.push(legend);

		const choice = await ctx.ui.select("Agent types", options);
		if (!choice) return;

		const agentName = choice
			.split(" · ")[0]
			.replace(/^[•◦✕\s]+/, "")
			.trim();
		if (getAgentConfig(agentName)) {
			await showAgentDetail(ctx, agentName);
			await showAllAgentsList(ctx);
		}
	}

	async function showRunningAgents(ctx: ExtensionCommandContext) {
		const agents = manager.listAgents();
		if (agents.length === 0) {
			ctx.ui.notify("No agents.", "info");
			return;
		}

		const options = agents.map((a) => {
			const dn = getDisplayName(a.type);
			const dur = formatDuration(a.startedAt, a.completedAt);
			return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
		});

		const choice = await ctx.ui.select("Running agents", options);
		if (!choice) return;

		// Find the selected agent by matching the option index
		const idx = options.indexOf(choice);
		if (idx < 0) return;
		const record = agents[idx];

		await viewAgentConversation(ctx, record);
		// Back-navigation: re-show the list
		await showRunningAgents(ctx);
	}

	async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
		if (!record.session) {
			ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
			return;
		}

		const { ConversationViewer } = await import("./ui/conversation-viewer.js");
		const session = record.session;
		const activity = agentActivity.get(record.id);

		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => {
				return new ConversationViewer(tui, session, record, activity, theme, done);
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%" },
			},
		);
	}

	async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
		const cfg = getAgentConfig(name);
		if (!cfg) {
			ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
			return;
		}

		const file = findAgentFile(name);
		const isDefault = cfg.isDefault === true;
		const disabled = cfg.enabled === false;
		const modelOption = `Model preset (${getModelLabel(name, ctx.modelRegistry)})`;
		const thinkingOption = `Thinking default (${cfg.thinking ?? (cfg.modelPreset ? "preset" : "inherit")})`;

		let menuOptions: string[];
		if (disabled && file) {
			// Disabled agent with a file — offer Enable
			menuOptions = isDefault
				? [modelOption, thinkingOption, "Enable", "Edit", "Reset to default", "Delete", "Back"]
				: [modelOption, thinkingOption, "Enable", "Edit", "Delete", "Back"];
		} else if (isDefault && !file) {
			// Default agent with no .md override
			menuOptions = [modelOption, thinkingOption, "Eject (export as .md)", "Disable", "Back"];
		} else if (isDefault && file) {
			// Default agent with .md override (ejected)
			menuOptions = [modelOption, thinkingOption, "Edit", "Disable", "Reset to default", "Delete", "Back"];
		} else {
			// User-defined agent
			menuOptions = [modelOption, thinkingOption, "Edit", "Disable", "Delete", "Back"];
		}

		const choice = await ctx.ui.select(name, menuOptions);
		if (!choice || choice === "Back") return;

		if (choice.startsWith("Model preset")) {
			await configureAgentModelPreset(ctx, name, cfg);
		} else if (choice.startsWith("Thinking default")) {
			await configureAgentThinking(ctx, name, cfg);
		} else if (choice === "Edit" && file) {
			const content = readFileSync(file.path, "utf-8");
			const edited = await ctx.ui.editor(`Edit ${name}`, content);
			if (edited !== undefined && edited !== content) {
				const { writeFileSync } = await import("node:fs");
				writeFileSync(file.path, edited, "utf-8");
				reloadCustomAgents();
				ctx.ui.notify(`Updated ${file.path}`, "info");
			}
		} else if (choice === "Delete") {
			if (file) {
				const confirmed = await ctx.ui.confirm(
					"Delete agent",
					`Delete ${name} from ${file.location} (${file.path})?`,
				);
				if (confirmed) {
					unlinkSync(file.path);
					reloadCustomAgents();
					ctx.ui.notify(`Deleted ${file.path}`, "info");
				}
			}
		} else if (choice === "Reset to default" && file) {
			const confirmed = await ctx.ui.confirm(
				"Reset to default",
				`Delete override ${file.path} and restore embedded default?`,
			);
			if (confirmed) {
				unlinkSync(file.path);
				reloadCustomAgents();
				ctx.ui.notify(`Restored default ${name}`, "info");
			}
		} else if (choice.startsWith("Eject")) {
			await ejectAgent(ctx, name, cfg);
		} else if (choice === "Disable") {
			await disableAgent(ctx, name);
		} else if (choice === "Enable") {
			await enableAgent(ctx, name);
		}
	}

	/** Eject a default agent: write its embedded config as a .md file. */
	async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
		const location = await ctx.ui.select("Choose location", [
			"Project (.pi/agents/)",
			`Personal (${personalAgentsDir()})`,
		]);
		if (!location) return;

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
		mkdirSync(targetDir, { recursive: true });

		const targetPath = join(targetDir, `${name}.md`);
		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
			if (!overwrite) return;
		}

		const { writeFileSync } = await import("node:fs");
		writeFileSync(targetPath, buildAgentMarkdownContent(cfg), "utf-8");
		reloadCustomAgents();
		ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
	}

	/** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
	async function disableAgent(ctx: ExtensionCommandContext, name: string) {
		const file = findAgentFile(name);
		if (file) {
			// Existing file — set enabled: false in frontmatter (idempotent)
			const content = readFileSync(file.path, "utf-8");
			if (content.includes("\nenabled: false\n")) {
				ctx.ui.notify(`${name} is already disabled.`, "info");
				return;
			}
			const updated = content.replace(/^---\n/, "---\nenabled: false\n");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(file.path, updated, "utf-8");
			reloadCustomAgents();
			ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
			return;
		}

		// No file (built-in default) — create a stub
		const location = await ctx.ui.select("Choose location", [
			"Project (.pi/agents/)",
			`Personal (${personalAgentsDir()})`,
		]);
		if (!location) return;

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
		mkdirSync(targetDir, { recursive: true });

		const targetPath = join(targetDir, `${name}.md`);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
		reloadCustomAgents();
		ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
	}

	/** Enable a disabled agent by removing enabled: false from its frontmatter. */
	async function enableAgent(ctx: ExtensionCommandContext, name: string) {
		const file = findAgentFile(name);
		if (!file) return;

		const content = readFileSync(file.path, "utf-8");
		const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
		const { writeFileSync } = await import("node:fs");

		// If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
		if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
			unlinkSync(file.path);
			reloadCustomAgents();
			ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
		} else {
			writeFileSync(file.path, updated, "utf-8");
			reloadCustomAgents();
			ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
		}
	}

	async function showCreateWizard(ctx: ExtensionCommandContext) {
		const location = await ctx.ui.select("Choose location", [
			"Project (.pi/agents/)",
			`Personal (${personalAgentsDir()})`,
		]);
		if (!location) return;

		const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

		const method = await ctx.ui.select("Creation method", [
			"Generate with Claude (recommended)",
			"Manual configuration",
		]);
		if (!method) return;

		if (method.startsWith("Generate")) {
			await showGenerateWizard(ctx, targetDir);
		} else {
			await showManualWizard(ctx, targetDir);
		}
	}

	async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
		const description = await ctx.ui.input("Describe what this agent should do");
		if (!description) return;

		const name = await ctx.ui.input("Agent name (filename, no spaces)");
		if (!name) return;

		mkdirSync(targetDir, { recursive: true });

		const targetPath = join(targetDir, `${name}.md`);
		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
			if (!overwrite) return;
		}

		ctx.ui.notify("Generating agent definition...", "info");

		const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <optional comma-separated exact tool allowlist. Use "none" for no tools. Omit to inherit the parent active tools>
model_preset: <optional preset name such as fast, small, efficient, smart, oracle. Omit to inherit parent model>
model: <legacy optional explicit model as "provider/modelId" for advanced/manual overrides>
thinking: <optional thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
isolated: <true for no extension/MCP tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

		const record = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
			description: `Generate ${name} agent`,
			maxTurns: 5,
		});

		if (record.status === "error") {
			ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
			return;
		}

		reloadCustomAgents();

		if (existsSync(targetPath)) {
			ctx.ui.notify(`Created ${targetPath}`, "info");
		} else {
			ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
		}
	}

	async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
		// 1. Name
		const name = await ctx.ui.input("Agent name (filename, no spaces)");
		if (!name) return;

		// 2. Description
		const description = await ctx.ui.input("Description (one line)");
		if (!description) return;

		// 3. Tools
		const toolChoice = await ctx.ui.select("Tools", [
			"all",
			"none",
			"read-only (read, bash, grep, find, ls)",
			"custom...",
		]);
		if (!toolChoice) return;

		let toolsLine = "";
		if (toolChoice === "all") {
			toolsLine = "";
		} else if (toolChoice === "none") {
			toolsLine = "\ntools: none";
		} else if (toolChoice.startsWith("read-only")) {
			toolsLine = "\ntools: read, bash, grep, find, ls";
		} else {
			const customTools = await ctx.ui.input("Tools (comma-separated)", "read, bash, edit, write, grep, find, ls");
			if (!customTools) return;
			toolsLine = `\ntools: ${customTools}`;
		}

		// 4. Model preset
		const modelChoice = await ctx.ui.select("Model preset", [
			"inherit (parent model)",
			...orderedModelPresetNames(customModelPresets),
		]);
		if (!modelChoice) return;

		let modelLine = "";
		if (modelChoice !== "inherit (parent model)") modelLine = `\nmodel_preset: ${modelChoice}`;

		// 5. Thinking
		const thinkingChoice = await ctx.ui.select("Thinking level", [
			"inherit",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		if (!thinkingChoice) return;

		let thinkingLine = "";
		if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

		// 6. System prompt
		const systemPrompt = await ctx.ui.editor("System prompt", "");
		if (systemPrompt === undefined) return;

		// Build the file
		const content = `---
description: ${description}
${toolsLine}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

		mkdirSync(targetDir, { recursive: true });
		const targetPath = join(targetDir, `${name}.md`);

		if (existsSync(targetPath)) {
			const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
			if (!overwrite) return;
		}

		const { writeFileSync } = await import("node:fs");
		writeFileSync(targetPath, content, "utf-8");
		reloadCustomAgents();
		ctx.ui.notify(`Created ${targetPath}`, "info");
	}

	function snapshotSettings(): SubagentsSettings {
		return {
			maxConcurrent: manager.getMaxConcurrent(),
			// 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
			// normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
			defaultMaxTurns: getDefaultMaxTurns() ?? 0,
			graceTurns: getGraceTurns(),
			defaultJoinMode: getDefaultJoinMode(),
			schedulingEnabled: isSchedulingEnabled(),
			modelPresets: customPresetSnapshot(),
		};
	}

	async function showSettings(ctx: ExtensionCommandContext) {
		const choice = await ctx.ui.select("Settings", [
			`Max concurrency (current: ${manager.getMaxConcurrent()})`,
			`Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
			`Grace turns (current: ${getGraceTurns()})`,
			`Join mode (current: ${getDefaultJoinMode()})`,
			`Scheduling (current: ${isSchedulingEnabled() ? "enabled" : "disabled"})`,
		]);
		if (!choice) return;

		if (choice.startsWith("Max concurrency")) {
			const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
			if (val) {
				const n = parseInt(val, 10);
				if (n >= 1) {
					manager.setMaxConcurrent(n);
					notifyApplied(ctx, `Max concurrency set to ${n}`);
				} else {
					ctx.ui.notify("Must be a positive integer.", "warning");
				}
			}
		} else if (choice.startsWith("Default max turns")) {
			const val = await ctx.ui.input(
				"Default max turns before wrap-up (0 = unlimited)",
				String(getDefaultMaxTurns() ?? 0),
			);
			if (val) {
				const n = parseInt(val, 10);
				if (n === 0) {
					setDefaultMaxTurns(undefined);
					notifyApplied(ctx, "Default max turns set to unlimited");
				} else if (n >= 1) {
					setDefaultMaxTurns(n);
					notifyApplied(ctx, `Default max turns set to ${n}`);
				} else {
					ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
				}
			}
		} else if (choice.startsWith("Grace turns")) {
			const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()));
			if (val) {
				const n = parseInt(val, 10);
				if (n >= 1) {
					setGraceTurns(n);
					notifyApplied(ctx, `Grace turns set to ${n}`);
				} else {
					ctx.ui.notify("Must be a positive integer.", "warning");
				}
			}
		} else if (choice.startsWith("Join mode")) {
			const val = await ctx.ui.select("Default join mode for background agents", [
				"smart — auto-group 2+ agents in same turn (default)",
				"async — always notify individually",
				"group — always group background agents",
			]);
			if (val) {
				const mode = val.split(" ")[0] as JoinMode;
				setDefaultJoinMode(mode);
				notifyApplied(ctx, `Default join mode set to ${mode}`);
			}
		} else if (choice.startsWith("Scheduling")) {
			const val = await ctx.ui.select("Schedule subagent feature", [
				"enabled — /mosaic settings → Scheduled jobs visible",
				"disabled — scheduled jobs menu not shown",
			]);
			if (val) {
				const enabled = val.startsWith("enabled");
				if (enabled === isSchedulingEnabled()) {
					ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
				} else {
					setSchedulingEnabled(enabled);
					if (!enabled) scheduler.stop(); // immediate kill — outstanding fires stop ticking
					notifyApplied(
						ctx,
						`Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
					);
				}
			}
		}
	}

	// Persist the current snapshot, emit `subagents:settings_changed`, and surface
	// the right toast. Successful saves show info; persistence failures downgrade
	// to warning so users aren't silently reverted on restart. Event fires regardless
	// of outcome so listeners see the in-memory change.
	function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
		const { message, level } = saveAndEmitChanged(snapshotSettings(), successMsg, (event, payload) =>
			pi.events.emit(event, payload),
		);
		ctx.ui.notify(message, level);
	}

	const mosaicSubcommands = [
		{
			value: "settings",
			label: "settings",
			description: "Configure agents, model defaults, schedules, and mosaic behavior",
		},
		{
			value: "list",
			label: "list",
			description: "List and manage backgrounded mosaic sessions",
		},
	];

	pi.registerCommand("mosaic", {
		description: "Manage mosaic. Usage: /mosaic settings|list",
		getArgumentCompletions: (prefix: string) => {
			const value = prefix.trim().toLowerCase();
			const items = mosaicSubcommands.filter((item) => item.value.startsWith(value));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subcommand] = args.trim().split(/\s+/, 1);
			if (!subcommand || subcommand === "settings") {
				await showAgentsMenu(ctx);
				return;
			}
			if (subcommand === "list") {
				await showMosaicSessions(ctx);
				return;
			}
			ctx.ui.notify("Usage: /mosaic settings|list", "error");
		},
	});
}
