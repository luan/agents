import { DEFAULT_COMPACTION_SETTINGS, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_COMPACT_AT_PERCENT = 85;
const MESSAGE_TYPE = "auto-compact-resume";
const compactionReasonOverrideKey = Symbol.for("agents.pi.compaction-reason.override");
const compactionReasonGlobal = globalThis as typeof globalThis & {
	[compactionReasonOverrideKey]?: "threshold";
};
const STOP_FOR_COMPACTION =
	"End the current response immediately. Output no text and do not call tools. Context compaction will run, then the task will resume.";

function compactAtPercent(): number {
	const configured = Number(process.env.PI_AUTO_COMPACT_PERCENT);
	return configured > 0 && configured <= 100 ? configured : DEFAULT_COMPACT_AT_PERCENT;
}

export function needsCompaction(
	content: readonly { type: string }[],
	tokens: number | null,
	contextWindow: number,
): boolean {
	return (
		content.some((part) => part.type === "toolCall") &&
		tokens !== null &&
		tokens >= DEFAULT_COMPACTION_SETTINGS.keepRecentTokens * 2 &&
		tokens / contextWindow >= compactAtPercent() / 100
	);
}

export default function autoCompactResumeExtension(pi: ExtensionAPI) {
	let waitingToCompact = false;
	let compacting = false;

	const resume = (ctx: ExtensionContext) => {
		delete compactionReasonGlobal[compactionReasonOverrideKey];
		compacting = false;
		if (ctx.hasPendingMessages()) return;
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: "Continue the original request from the compacted context.",
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		if (waitingToCompact || compacting) return;

		const usage = ctx.getContextUsage();
		// Only some AgentMessage variants carry content; reading it blind threw on the rest.
		const message = event.message;
		const content = "content" in message && Array.isArray(message.content) ? message.content : [];
		if (!usage || !needsCompaction(content, usage.tokens, usage.contextWindow)) {
			return;
		}

		waitingToCompact = true;
	});

	pi.on("context", (event) => {
		if (!waitingToCompact) return;

		return {
			messages: [
				...event.messages,
				{
					role: "user",
					content: [{ type: "text", text: STOP_FOR_COMPACTION }],
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("message_end", (event) => {
		if (!waitingToCompact || event.message.role !== "assistant" || event.message.stopReason !== "stop") {
			return;
		}

		return {
			message: {
				...event.message,
				content: [],
			},
		};
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		if (!waitingToCompact) return;

		waitingToCompact = false;
		compacting = true;
		compactionReasonGlobal[compactionReasonOverrideKey] = "threshold";
		ctx.compact({
			onComplete: () => resume(ctx),
			onError: () => resume(ctx),
		});
	});
}
