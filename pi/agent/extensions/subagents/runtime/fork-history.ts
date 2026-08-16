import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ForkTurns = "none" | "all" | number;

const COLLABORATION_ENVELOPE = /^Message Type: (?:MESSAGE|FINAL_ANSWER)\nTask name: \/root(?:\/|$)/;

function textContent(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function isStaleSubagentMessage(message: AgentMessage): boolean {
	if (COLLABORATION_ENVELOPE.test(textContent(message))) return true;
	if (message.role !== "custom") return false;
	return /^subagents?(?:[:_-]|$)/.test(message.customType);
}

function sanitizeIncompleteTurn(messages: readonly AgentMessage[]): AgentMessage[] {
	const sanitized: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (
			message.role !== "assistant" ||
			(!message.content.some((part) => part.type === "toolCall") && message.stopReason !== "toolUse")
		) {
			sanitized.push(message);
			continue;
		}
		const content = message.content.filter((part) => part.type !== "toolCall");
		if (content.length === 0) continue;
		sanitized.push({
			...message,
			content,
			stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
		});
	}
	return sanitized;
}

/**
 * Select sanitized fork turns from a parent transcript.
 *
 * Real user messages and triggered follow-up messages start turns. The coordinator
 * supplies timestamps for queued steering messages, which remain inside the current turn.
 * An active tool turn is sanitized by removing unresolved tool calls and results while
 * preserving the user task and any assistant text.
 */
export function selectForkedHistory(
	messages: readonly AgentMessage[],
	forkTurns: ForkTurns,
	nonBoundaryTimestamps?: ReadonlySet<number>,
): AgentMessage[] {
	if (forkTurns === "none") return [];
	if (typeof forkTurns === "number" && (!Number.isInteger(forkTurns) || forkTurns < 1)) {
		throw new Error("fork_turns must be none, all, or a positive integer");
	}

	const isBoundary = (message: AgentMessage): boolean =>
		message.role === "user" && !nonBoundaryTimestamps?.has(message.timestamp);
	const preamble: AgentMessage[] = [];
	const turns: AgentMessage[][] = [];
	let turn: AgentMessage[] | undefined;
	let staleUser = false;
	const finishTurn = () => {
		if (!turn) return;
		const clean = turn.filter((message) => !isStaleSubagentMessage(message));
		const last = clean.at(-1);
		if (!staleUser) {
			turns.push(
				last?.role === "assistant" && last.stopReason !== "toolUse" ? clean : sanitizeIncompleteTurn(clean),
			);
		}
		turn = undefined;
		staleUser = false;
	};
	for (const message of messages) {
		if (isBoundary(message)) {
			finishTurn();
			turn = [message];
			staleUser = isStaleSubagentMessage(message);
			continue;
		}
		if (turn) {
			turn.push(message);
			continue;
		}
		preamble.push(message);
	}
	finishTurn();

	const selected = forkTurns === "all" ? [preamble, ...turns] : turns.slice(-forkTurns);
	return selected.flat().filter((message) => !isStaleSubagentMessage(message));
}
