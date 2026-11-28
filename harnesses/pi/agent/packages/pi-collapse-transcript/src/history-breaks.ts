import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** How a displayed part affects the current activity fold: thinking and tools extend it, anything else ends it. */
type FoldEffect = "extend" | "end";

/** The fold effects of one saved entry, in the order its parts appear in the transcript. */
function foldEffects(entry: SessionEntry): FoldEffect[] {
	switch (entry.type) {
		case "compaction":
		case "branch_summary":
			return ["end"];
		case "custom_message":
			return entry.display ? ["end"] : [];
		case "message":
			break;
		default:
			// Extension state and settings changes render nothing, or a notice that only ends a fold earlier.
			return [];
	}
	const message = entry.message;
	switch (message.role) {
		case "toolResult":
			// Results render inside their tool call.
			return [];
		case "user": {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			return text.trim() ? ["end"] : [];
		}
		case "custom":
			return message.display ? ["end"] : [];
		case "assistant": {
			// Error and truncation notices stay visible as their own entry.
			if (["error", "aborted", "length"].includes(message.stopReason)) return ["end"];
			const effects: FoldEffect[] = [];
			for (const part of message.content) {
				if (part.type === "thinking" && part.thinking.trim()) effects.push("extend");
				else if (part.type === "text" && part.text.trim()) effects.push("end");
			}
			// Tool calls render after the message text, each as its own activity.
			if (message.content.some((part) => part.type === "toolCall")) effects.push("extend");
			return effects;
		}
		default:
			return ["end"];
	}
}

/**
 * For one compaction epoch, whether a history page may start before each entry without splitting an
 * activity fold. A page start ends the current fold, so pages start only where no fold is open or where
 * the entry ends it anyway.
 */
export function activityBreaks(entries: readonly SessionEntry[]): boolean[] {
	let open = false;
	return entries.map((entry) => {
		const effects = foldEffects(entry);
		const clean = !open || effects[0] === "end";
		if (effects.length) open = effects.at(-1) === "extend";
		return clean;
	});
}
