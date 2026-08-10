import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPACT_AT_PERCENT = 85;
const MESSAGE_TYPE = "auto-compact-resume";

export function needsCompaction(
	content: readonly { type: string }[],
	tokens: number | null,
	contextWindow: number,
): boolean {
	return (
		content.some((part) => part.type === "toolCall") &&
		tokens !== null &&
		tokens / contextWindow >= COMPACT_AT_PERCENT / 100
	);
}

export default function autoCompactResumeExtension(pi: ExtensionAPI) {
	let resumeAfterCompaction = false;

	pi.on("turn_end", (event, ctx: ExtensionContext) => {
		if (resumeAfterCompaction) return;

		const usage = ctx.getContextUsage();
		// Only some AgentMessage variants carry content; reading it blind threw on the rest.
		const message = event.message;
		const content = "content" in message && Array.isArray(message.content) ? message.content : [];
		if (!usage || !needsCompaction(content, usage.tokens, usage.contextWindow)) {
			return;
		}

		resumeAfterCompaction = true;
		ctx.abort();
	});

	pi.on("session_compact", (_event, ctx: ExtensionContext) => {
		if (!resumeAfterCompaction) return;

		resumeAfterCompaction = false;
		if (ctx.hasPendingMessages()) return;
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: "Continue the original request from the compacted context.",
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	pi.on("agent_settled", () => {
		resumeAfterCompaction = false;
	});
}
