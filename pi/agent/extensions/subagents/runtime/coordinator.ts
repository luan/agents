import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_USAGE_ENTRY_TYPE,
	SUBAGENT_USAGE_EVENT,
	type SubagentUsageEvent,
} from "../../shared/subagent-usage.js";
import { AgentManager } from "./agent-manager.js";
import { toPersistedAgent, writeAgentRegistry } from "./persistence.js";
import type { AgentRecord } from "./types.js";
import type { AgentActivity, AgentWidget } from "./ui/agent-widget.js";

type SessionBinding = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
};

const bindings = new Map<string, SessionBinding>();
const widgets = new Set<AgentWidget>();
const activityByAgent = new Map<string, AgentActivity>();
const completionBatches = new Map<string, Map<string, AgentRecord>>();
const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const COMPLETION_BATCH_MS = 250;

function formatCompletionBatch(records: AgentRecord[]): string {
	return records
		.map((record) => {
			const output = record.error || record.result || "No output.";
			return `## ${record.id} (${record.status})\n${output.slice(0, 10_000)}`;
		})
		.join("\n\n");
}

export function buildCompletionMessage(records: AgentRecord[]) {
	return {
		message: {
			customType: "subagents-complete",
			content: formatCompletionBatch(records),
			display: false,
			details: { agents: records.map(toPersistedAgent) },
		},
		options: { deliverAs: "followUp" as const, triggerTurn: true },
	};
}

function queueCompletion(binding: SessionBinding, record: AgentRecord): void {
	const sessionId = binding.ctx.sessionManager.getSessionId();
	let batch = completionBatches.get(sessionId);
	if (!batch) {
		batch = new Map();
		completionBatches.set(sessionId, batch);
	}
	batch.set(record.id, record);
	if (completionTimers.has(sessionId)) return;
	const timer = setTimeout(() => {
		completionTimers.delete(sessionId);
		const records = [...(completionBatches.get(sessionId)?.values() ?? [])];
		if (records.length === 0) return;
		const currentBinding = bindings.get(sessionId);
		if (!currentBinding) return;
		try {
			const completion = buildCompletionMessage(records);
			currentBinding.pi.sendMessage(completion.message, completion.options);
			completionBatches.delete(sessionId);
			for (const completed of records) {
				completed.completionDelivered = true;
				persist(completed);
			}
		} catch {
			const retry = setTimeout(() => {
				completionTimers.delete(sessionId);
				const retryBinding = bindings.get(sessionId);
				if (retryBinding) queueCompletion(retryBinding, record);
			}, 1000);
			retry.unref();
			completionTimers.set(sessionId, retry);
		}
	}, COMPLETION_BATCH_MS);
	timer.unref();
	completionTimers.set(sessionId, timer);
}

function reportUsage(record: AgentRecord): void {
	if (record.usageReported) return;
	const binding = bindings.get(record.rootSessionId);
	if (!binding) return;
	const usage: SubagentUsageEvent = {
		input: record.lifetimeUsage.input,
		output: record.lifetimeUsage.output,
		cost: record.lifetimeUsage.cost,
		sessionFile: binding.ctx.sessionManager.getSessionFile() ?? undefined,
	};
	if (usage.input === 0 && usage.output === 0 && usage.cost === 0) return;
	try {
		binding.pi.appendEntry(SUBAGENT_USAGE_ENTRY_TYPE, usage);
		record.usageReported = true;
		persist(record);
	} catch {
		return;
	}
	try {
		binding.pi.events.emit(SUBAGENT_USAGE_EVENT, usage);
	} catch {}
}

function persist(record: AgentRecord): void {
	writeAgentRegistry(record.rootSessionId, manager.listAgents(record.rootSessionId));
}

function updateWidgets(): void {
	for (const widget of widgets) widget.update();
}

function deliverCompletion(record: AgentRecord, force = false): void {
	reportUsage(record);
	if ((!record.isBackground && !force) || record.completionDelivered) return;
	const output = record.error || record.result || "No output.";
	const parent = record.parentAgentId ? manager.getRecord(record.parentAgentId) : undefined;
	if (parent?.status === "running") {
		void manager
			.steer(
				parent.id,
				`Child agent ${record.id} ${record.status}. Integrate this result before finishing.\n\n${output.slice(0, 50 * 1024)}`,
			)
			.then((sent) => {
				if (!sent) {
					deliverCompletion(record, force);
					return;
				}
				record.completionDelivered = true;
				persist(record);
			})
			.catch(() => deliverCompletion(record, force));
		return;
	}
	const binding = getSessionRuntime(record.parentSessionId, record.rootSessionId);
	if (!binding) return;
	if (parent) {
		record.completionDelivered = true;
		persist(record);
		void manager
			.resume(
				binding.pi,
				binding.ctx,
				parent.id,
				`Child agent ${record.id} ${record.status}. Integrate this result and return an updated handoff.\n\n${output.slice(0, 50 * 1024)}`,
				{ deliverCompletion: true },
			)
			.then((updated) => {
				if (!updated) {
					record.completionDelivered = false;
					persist(record);
					return;
				}
				if (!updated.isBackground) {
					persist(updated);
					updateWidgets();
					deliverCompletion(updated, true);
				}
			});
		return;
	}
	queueCompletion(binding, record);
}

const manager = new AgentManager(
	(record) => {
		persist(record);
		updateWidgets();
		deliverCompletion(record);
	},
	undefined,
	(record) => {
		persist(record);
		updateWidgets();
	},
	(record) => {
		persist(record);
		updateWidgets();
	},
	(record) => {
		activityByAgent.delete(record.id);
		persist(record);
		updateWidgets();
	},
);

export function getSharedAgentManager(): AgentManager {
	return manager;
}

export function getSharedAgentActivity(): Map<string, AgentActivity> {
	return activityByAgent;
}

export function registerAgentWidget(widget: AgentWidget): void {
	widgets.add(widget);
}

export function unregisterAgentWidget(widget: AgentWidget): void {
	widgets.delete(widget);
}

export function registerSessionBinding(pi: ExtensionAPI, ctx: ExtensionContext): void {
	bindings.set(ctx.sessionManager.getSessionId(), { pi, ctx });
	manager.drain();
}
export function getSessionRuntime(
	sessionId: string,
	rootSessionId: string,
): { pi: ExtensionAPI; ctx: ExtensionContext } | undefined {
	return bindings.get(sessionId) ?? bindings.get(rootSessionId);
}

export function unregisterSessionBinding(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (bindings.get(sessionId)?.ctx === ctx) bindings.delete(sessionId);
}

export function persistAgent(record: AgentRecord): void {
	persist(record);
}

export function deliverPendingForSession(sessionId: string): void {
	for (const record of manager.listAgents()) {
		if (record.parentSessionId === sessionId) deliverCompletion(record);
	}
}
