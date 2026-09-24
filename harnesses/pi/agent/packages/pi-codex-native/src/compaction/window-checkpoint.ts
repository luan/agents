import type { Api, Model } from "@earendil-works/pi-ai";
import { canonicalCompactionOutput } from "./remote-v2-history.ts";
import { isNativeCompactionDetails } from "./types.ts";
import type { ResponsesInputItem } from "./serializer.ts";

// type-boundary: provider checkpoint JSON stored opaquely by a context manager; isNativeCompactionDetails validates it before replay.
type StoredCheckpoint = unknown;
export function replayWindowCheckpoint(
	checkpoint: string | undefined,
	model: Model<Api>,
	input: readonly ResponsesInputItem[],
): ResponsesInputItem[] {
	if (!checkpoint) return [...input];
	const details: StoredCheckpoint = JSON.parse(checkpoint);
	if (!isNativeCompactionDetails(details) || details.compactedWindow.filter(canonicalCompactionOutput).length !== 1)
		throw new Error("Invalid provider context checkpoint; refusing to drop saved context");
	if (
		details.provider !== model.provider ||
		details.api !== model.api ||
		details.baseUrl.replace(/\/+$/, "") !== model.baseUrl.replace(/\/+$/, "")
	)
		throw new Error("The context checkpoint belongs to a different provider endpoint");
	// Remote-v2 retains real user requests. Window recovery reminders are regenerated for the new window.
	const retained = (details.compactedWindow as ResponsesInputItem[]).filter((item) => {
		if (!("role" in item) || item.role !== "user") return true;
		const content =
			typeof item.content === "string"
				? item.content
				: Array.isArray(item.content)
					? item.content
							.map((part) =>
								part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
							)
							.join("\n")
					: "";
		return !(content.trim().startsWith("<context_window>") && content.trim().endsWith("</context_window>"));
	});
	let prefix = 0;
	for (const item of input) {
		if (!("role" in item) || (item.role !== "developer" && item.role !== "system")) break;
		prefix++;
	}
	return [...input.slice(0, prefix), ...structuredClone(retained), ...input.slice(prefix)];
}
