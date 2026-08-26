import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ForkTurns = "none" | "all" | number;

export function parseForkTurns(value: string | undefined): ForkTurns {
	const forkTurns = value?.trim() || "all";
	if (forkTurns === "all" || forkTurns === "none") return forkTurns;
	if (/^[1-9]\d*$/.test(forkTurns)) {
		const count = Number(forkTurns);
		if (Number.isSafeInteger(count)) return count;
	}
	throw new Error("fork_turns must be none, all, or a positive integer string");
}

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

/** Select sanitized completed turns from a parent transcript for a child session. */
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
		let finalAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
		for (let index = clean.length - 1; index >= 0; index--) {
			const message = clean[index];
			if (message?.role !== "assistant") continue;
			finalAssistant = message;
			break;
		}
		if (!staleUser && finalAssistant && finalAssistant.stopReason !== "toolUse") turns.push(clean);
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
		if (turn) turn.push(message);
		else preamble.push(message);
	}
	finishTurn();

	const selected = forkTurns === "all" ? [preamble, ...turns] : turns.slice(-forkTurns);
	return selected.flat().filter((message) => !isStaleSubagentMessage(message));
}
