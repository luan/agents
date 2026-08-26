import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AGENT_TOOLS } from "../names.ts";
import type { CollaborationToolScope } from "../scope.ts";
import { waitAgentResult, type WaitAgentDetails } from "./result.ts";

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;

const PARAMETERS = Type.Object(
	{
		timeout_ms: Type.Optional(
			Type.Number({
				minimum: MIN_WAIT_TIMEOUT_MS,
				maximum: MAX_WAIT_TIMEOUT_MS,
				description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function waitTimeout(requestedMs: number | undefined): number {
	const requested = Number.isFinite(requestedMs) ? (requestedMs ?? DEFAULT_WAIT_TIMEOUT_MS) : DEFAULT_WAIT_TIMEOUT_MS;
	return Math.min(Math.max(MIN_WAIT_TIMEOUT_MS, requested), MAX_WAIT_TIMEOUT_MS);
}

export function createWaitAgentTool(
	scope: CollaborationToolScope,
): ToolDefinition<typeof PARAMETERS, WaitAgentDetails> {
	return {
		name: AGENT_TOOLS.waitAgent,
		label: "Wait For Agent",
		description:
			"Wait for a mailbox update from any live agent. The wait ends on a message, settlement, interruption, timeout, or new input that aborts the active tool call.",
		promptGuidelines: [
			"Prefer one longer wait_agent call over frequent polling while delegated work is still running.",
		],
		parameters: PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, parameters, signal) {
			const timeoutMs = waitTimeout(parameters.timeout_ms);
			const startedAt = Date.now();
			if (scope.otherLiveAgents().length === 0) {
				return waitAgentResult({
					text: "No other live agents are available for mailbox updates.",
					outcome: "none",
					timeoutMs,
					durationMs: 0,
				});
			}
			const update = await scope.coordinator().waitForUpdate(signal, timeoutMs);
			const target =
				update?.type === "message"
					? update.sender
					: update?.type === "settled" || update?.type === "interrupted"
						? update.agent.id
						: undefined;
			const agentStatus =
				update?.type === "settled" || update?.type === "interrupted" ? update.agent.status : undefined;
			const outcome = signal?.aborted ? "aborted" : update ? "updated" : "timeout";
			const text = signal?.aborted
				? "The mailbox wait ended because new input interrupted the active turn."
				: !update
					? "No agent updates arrived before the timeout."
					: update.type === "message"
						? `Mailbox update from ${update.sender}.`
						: update.type === "settled" || update.type === "interrupted"
							? `Agent update: ${update.agent.id} (${update.agent.status}).`
							: "Agent transcript updated.";
			return waitAgentResult({
				text,
				outcome,
				timeoutMs,
				durationMs: Date.now() - startedAt,
				target,
				agentStatus,
			});
		},
	};
}
