import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi compacts below `compaction.reserveTokens`, configured here at 20,000 (`core/compaction/compaction.js`: `contextTokens > contextWindow - reserveTokens`).
// 40,000 is twice that reserve: one more large turn of runway, so the warning lands while the model can still write state down.
const REMAINING_TOKENS_THRESHOLD = 40_000;

export default function tokenBudgetExtension(pi: ExtensionAPI): void {
	let delivered = false;

	pi.on("session_compact", () => {
		delivered = false;
	});

	pi.on("turn_start", (_event, ctx) => {
		if (delivered) return;
		const usage = ctx.getContextUsage();
		// `tokens` is null right after compaction, before the next response reports usage. The window is fresh anyway.
		if (!usage?.tokens) return;
		const remaining = usage.contextWindow - usage.tokens;
		if (remaining > REMAINING_TOKENS_THRESHOLD) return;
		delivered = true;
		pi.sendMessage({
			customType: "token-budget",
			content: `You have ${remaining} tokens left in this context window.`,
			display: false,
		});
	});
}
