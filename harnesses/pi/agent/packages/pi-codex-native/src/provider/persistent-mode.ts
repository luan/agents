import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexNativeSettings } from "../contributions/xsettings.ts";
import { reminderIntervalMilliseconds, timeRemindersEnabled } from "./conversation-policy.ts";
import type { ResponsesBody } from "./types.ts";

// Codex 16537b20: models-manager/models.json (Astra) and core/assets/persistent_mode.md (fallback).
const fallback = readFileSync(new URL("../../assets/persistent-mode.md", import.meta.url), "utf8");
const astra = readFileSync(new URL("../../assets/persistent-mode-astra.md", import.meta.url), "utf8");
export const PERSISTENT_ENTRY = "pi-codex-native/persistent-context/v1";
const REPLACEMENT = "These persistent-mode instructions replace all previously provided persistent-mode instructions.";
const REMOVAL = "The previously provided persistent-mode instructions no longer apply.";

/** A developer-context change anchored before the next inference, after a complete input prefix. */
export interface PersistentContextEntry {
	version: 1;
	at: number;
	prefix: string;
	window?: string;
	reset?: true;
	instructions?: string;
	reminderTime?: number;
	boundaryAt?: number;
}
export interface PersistentRequestState {
	entries: PersistentContextEntry[];
}

// type-boundary: saved Pi custom entries; validate every field before replaying provider context.
type SavedValue = unknown;
function contextEntry(value: SavedValue): value is PersistentContextEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<PersistentContextEntry>;
	return (
		entry.version === 1 &&
		Number.isSafeInteger(entry.at) &&
		entry.at! >= 0 &&
		typeof entry.prefix === "string" &&
		/^[a-f0-9]{64}$/.test(entry.prefix) &&
		(entry.window === undefined || typeof entry.window === "string") &&
		(entry.reset === undefined || entry.reset === true) &&
		(entry.instructions === undefined || typeof entry.instructions === "string") &&
		(entry.boundaryAt === undefined || (Number.isSafeInteger(entry.boundaryAt) && entry.boundaryAt >= 0)) &&
		(entry.reminderTime === undefined ||
			(Number.isFinite(entry.reminderTime) && Math.abs(entry.reminderTime) <= 8.64e15))
	);
}

export function persistentHistory(entries: readonly SessionEntry[]): PersistentRequestState {
	const state: PersistentRequestState = { entries: [] };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PERSISTENT_ENTRY || !contextEntry(entry.data)) continue;
		if (entry.data.reset) state.entries = [];
		state.entries.push(entry.data);
	}
	return state;
}

/** Codex selects the model's catalog instructions before the generic fallback. */
export function persistentInstructions(model: string, questionToolAvailable: boolean): string {
	return (model === "gpt-6-astra" ? astra : fallback)
		.trim()
		.replace("{{ approval_request_channel }}", questionToolAvailable ? " via functions.send_user_message_async" : "");
}

/** Replay recorded context at its original boundary; only append changed instructions or due clocks. */
export function persistentRequest(
	body: ResponsesBody,
	settings: Pick<CodexNativeSettings, "reasoningMode" | "currentTimeReminder"> &
		Partial<Pick<CodexNativeSettings, "currentTimeReminderIntervalSeconds" | "currentTimeReminderDelivery">>,
	toolNames: readonly string[],
	now: number,
	previous: PersistentRequestState = { entries: [] },
	window?: string,
): { body: ResponsesBody; state: PersistentRequestState; added?: PersistentContextEntry } {
	const enabled = settings.reasoningMode === "persistent";
	const instructions = enabled
		? persistentInstructions(body.model, toolNames.includes("request_user_input_async"))
		: "";
	const hash = createHash("sha256");
	const prefixes = [hash.copy().digest("hex")];
	for (const item of body.input) {
		hash.update(JSON.stringify(item) ?? "null").update("\n");
		prefixes.push(hash.copy().digest("hex"));
	}
	// A branch, compaction, or changed input projection starts a fresh context baseline.
	const reset = previous.entries.some((entry) => entry.window !== window || prefixes[entry.at] !== entry.prefix);
	const entries = reset ? [] : [...previous.entries];
	let priorInstructions = "";
	let reminderTime: number | undefined;
	let boundaryAt = 0;
	for (const entry of entries) {
		if (entry.instructions !== undefined) priorInstructions = entry.instructions;
		if (entry.reminderTime !== undefined) reminderTime = entry.reminderTime;
		if (entry.boundaryAt !== undefined) boundaryAt = entry.boundaryAt;
	}
	const reminders = timeRemindersEnabled(settings);
	const interval = reminderIntervalMilliseconds(settings.currentTimeReminderIntervalSeconds ?? "1");
	const boundary = body.input.slice(boundaryAt).some((item) => isUserOrToolOutput(item));
	const eligible =
		settings.currentTimeReminderDelivery !== "after_user_or_tool_output" || reminderTime === undefined || boundary;
	const changed = instructions !== priorInstructions;
	const due =
		reminders &&
		eligible &&
		(reminderTime === undefined || interval === 0n || BigInt(Math.trunc(now - reminderTime)) >= interval);
	const added: PersistentContextEntry | undefined =
		changed || due || reset || (reminders && boundaryAt !== body.input.length)
			? {
					version: 1,
					at: body.input.length,
					prefix: prefixes[body.input.length]!,
					...(window === undefined ? {} : { window }),
					...(reset ? { reset: true } : {}),
					...(changed ? { instructions } : {}),
					...(due ? { reminderTime: now } : {}),
					...(reminders ? { boundaryAt: body.input.length } : {}),
				}
			: undefined;
	if (added) entries.push(added);
	const input: ResponsesBody["input"] = [];
	priorInstructions = "";
	let offset = 0;
	for (const entry of entries) {
		input.push(...body.input.slice(offset, entry.at));
		offset = entry.at;
		if (entry.instructions !== undefined) {
			const content = entry.instructions
				? priorInstructions
					? `${REPLACEMENT}\n\n${entry.instructions}`
					: entry.instructions
				: REMOVAL;
			input.push({ role: "developer", content: `<persistent_mode>\n${content}\n</persistent_mode>` });
			priorInstructions = entry.instructions;
		}
		if (entry.reminderTime !== undefined) {
			const time = new Date(entry.reminderTime).toISOString().slice(0, 19).replace("T", " ");
			input.push({ role: "developer", content: `<current_time_reminder>It is ${time} UTC.</current_time_reminder>` });
		}
	}
	input.push(...body.input.slice(offset));
	return {
		body:
			entries.length || enabled
				? {
						...body,
						...(enabled ? { reasoning: { ...body.reasoning, effort: "disabled" } } : {}),
						input,
					}
				: body,
		state: { entries },
		...(added ? { added } : {}),
	};
}

// type-boundary: Responses input items; inspect only validated role/type discriminants.
type InputItem = unknown;
function isUserOrToolOutput(item: InputItem): boolean {
	if (!item || typeof item !== "object") return false;
	const candidate = item as { role?: string; type?: string };
	return (
		candidate.role === "user" ||
		["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(candidate.type ?? "")
	);
}
