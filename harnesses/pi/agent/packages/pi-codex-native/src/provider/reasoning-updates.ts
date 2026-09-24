import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResponsesBody } from "./types.ts";

export const REASONING_ENTRY = "pi-codex-native/reasoning/v1";
const efforts = ["low", "medium", "high", "xhigh", "max", "disabled"] as const;
export type NativeEffort = (typeof efforts)[number];
export interface ReasoningEntry {
	version: 1;
	model: string;
	epoch: string;
	at: number;
	prefix: string;
	initial: NativeEffort;
	effort: NativeEffort;
	reset?: true;
}
// type-boundary: Pi session records and Responses input items; validators below narrow the wire fields.
type WireValue = unknown;
function isEffort(value: WireValue): value is NativeEffort {
	return typeof value === "string" && efforts.some((effort) => effort === value);
}
function isEntry(value: WireValue): value is ReasoningEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<ReasoningEntry>;
	return (
		entry.version === 1 &&
		typeof entry.model === "string" &&
		typeof entry.epoch === "string" &&
		Number.isSafeInteger(entry.at) &&
		entry.at! >= 0 &&
		typeof entry.prefix === "string" &&
		/^[a-f0-9]{64}$/.test(entry.prefix) &&
		isEffort(entry.initial) &&
		isEffort(entry.effort) &&
		(entry.reset === undefined || entry.reset === true)
	);
}
export function reasoningHistory(entries: readonly SessionEntry[]): ReasoningEntry[] {
	let result: ReasoningEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== REASONING_ENTRY) continue;
		if (!isEntry(entry.data)) throw new Error("Malformed saved Codex reasoning configuration");
		if (entry.data.reset) result = [];
		result.push(entry.data);
	}
	return result;
}
function configurationEffort(value: WireValue): NativeEffort | undefined {
	if (!value || typeof value !== "object" || !("type" in value) || value.type !== "configuration_update") return;
	if (
		!("reasoning" in value) ||
		!value.reasoning ||
		typeof value.reasoning !== "object" ||
		!("effort" in value.reasoning) ||
		!isEffort(value.reasoning.effort)
	)
		throw new Error("Invalid native reasoning update");
	return value.reasoning.effort;
}
export function normalizeConfigurationUpdates(body: ResponsesBody): ResponsesBody {
	if (!body.input.some((item) => configurationEffort(item) !== undefined)) return body;
	const astra = body.model.split("/").at(-1) === "gpt-6-astra";
	if (
		astra &&
		(body.truncation === "auto" || (Array.isArray(body.context_management) && body.context_management.length))
	)
		throw new Error(
			"Astra reasoning updates require explicit compaction; automatic truncation and server compaction are incompatible",
		);
	const input: ResponsesBody["input"] = [];
	for (const item of body.input) {
		if (configurationEffort(item) !== undefined) {
			if (!astra) continue;
			if (configurationEffort(input.at(-1)) !== undefined) input.pop();
		}
		input.push(item);
	}
	return { ...body, input };
}
function anchorsEffort(item: WireValue): boolean {
	return (
		!item || typeof item !== "object" || !("role" in item) || (item.role !== "developer" && item.role !== "system")
	);
}
/** Pin each context's initial effort and append changes at complete inference boundaries. */
export function reasoningRequest(
	body: ResponsesBody,
	previous: readonly ReasoningEntry[],
	epoch: string,
): {
	body: ResponsesBody;
	entries: ReasoningEntry[];
	added?: ReasoningEntry;
} {
	const effort = body.reasoning?.effort;
	if (body.model.split("/").at(-1) !== "gpt-6-astra" || !isEffort(effort))
		return { body: normalizeConfigurationUpdates(body), entries: [...previous] };
	const hash = createHash("sha256");
	const prefixes = [hash.copy().digest("hex")];
	for (const item of body.input) {
		// Current developer context may change without rewriting the conversation (for example a notes reminder).
		if (!anchorsEffort(item)) continue;
		hash.update(JSON.stringify(item) ?? "null").update("\n");
		prefixes.push(hash.copy().digest("hex"));
	}
	const reset = previous.some(
		(entry) => entry.model !== body.model || entry.epoch !== epoch || prefixes[entry.at] !== entry.prefix,
	);
	const entries = reset ? [] : [...previous];
	const last = entries.at(-1);
	const added: ReasoningEntry | undefined =
		!last || last.effort !== effort
			? {
					version: 1,
					model: body.model,
					epoch,
					at: prefixes.length - 1,
					prefix: prefixes.at(-1)!,
					initial: entries[0]?.initial ?? effort,
					effort,
					...(reset ? { reset: true as const } : {}),
				}
			: undefined;
	if (added) entries.push(added);
	const input: ResponsesBody["input"] = [];
	let at = 0;
	const insert = (position: number) => {
		for (const entry of entries.slice(1))
			if (entry.at === position) input.push({ type: "configuration_update", reasoning: { effort: entry.effort } });
	};
	for (const item of body.input) {
		if (anchorsEffort(item) && at === 0) insert(0);
		input.push(item);
		if (anchorsEffort(item)) {
			at++;
			if (at < prefixes.length - 1) insert(at);
		}
	}
	insert(at);
	return {
		body: normalizeConfigurationUpdates({
			...body,
			input,
			reasoning: { ...body.reasoning, effort: entries[0]!.initial },
		}),
		entries,
		...(added ? { added } : {}),
	};
}
