import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WINDOW_ENTRY = "pi-context/window";
export const ORIGIN_ENTRY = "pi-context/origin";
export const NOTE_ENTRY = "pi-context/note";
export const IDENTITY_ENTRY = "session.identity/v1";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface WindowState {
	version: 1;
	id: string;
	previous: string;
	checkpoint: string;
	providerCheckpoint?: string;
	summary?: string;
}
export interface SessionIdentity {
	version: 1;
	rootSessionId: string;
	rootSessionFile?: string;
	agentName: string;
}
export interface Note {
	path: string;
	text: string;
	createdAt: string;
	updatedAt: string;
}

// type-boundary: Pi custom entries and JSON tool results are untyped; these validators narrow them at ingestion.
type StoredValue = unknown;
export function isRecord(value: StoredValue): value is Record<string, StoredValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function jsonValue(value: StoredValue): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(jsonValue);
	if (isRecord(value))
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => [k, jsonValue(v)]),
		);
	throw new Error("Expected JSON data");
}
export function windowData(value: StoredValue): WindowState | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.previous !== "string" ||
		typeof value.checkpoint !== "string" ||
		(value.providerCheckpoint !== undefined && typeof value.providerCheckpoint !== "string")
	)
		return;
	return {
		version: 1,
		id: value.id,
		previous: value.previous,
		checkpoint: value.checkpoint,
		...(typeof value.summary === "string" ? { summary: value.summary } : {}),
		...(typeof value.providerCheckpoint === "string" ? { providerCheckpoint: value.providerCheckpoint } : {}),
	};
}
export function latestWindow(
	entries: readonly SessionEntry[],
): { entryId: string; index: number; state: WindowState } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== WINDOW_ENTRY) continue;
		const state = windowData(entry.data);
		if (!state) throw new Error("Invalid saved context window; refusing to restore old context");
		return { entryId: entry.id, index, state };
	}
}
export function sessionIdentity(entries: readonly SessionEntry[], sessionId: string): SessionIdentity {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== IDENTITY_ENTRY) continue;
		const value = entry.data;
		if (
			isRecord(value) &&
			value.version === 1 &&
			typeof value.rootSessionId === "string" &&
			typeof value.agentName === "string"
		)
			return {
				version: 1,
				rootSessionId: value.rootSessionId,
				agentName: value.agentName,
				...(typeof value.rootSessionFile === "string" ? { rootSessionFile: value.rootSessionFile } : {}),
			};
	}
	return { version: 1, rootSessionId: sessionId, agentName: "/root" };
}
export function readNotes(entries: readonly SessionEntry[]): Map<string, Note> {
	const notes = new Map<string, Note>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== NOTE_ENTRY) continue;
		const value = entry.data;
		if (!isRecord(value) || value.version !== 1 || typeof value.path !== "string" || typeof value.text !== "string")
			throw new Error("Invalid saved note");
		notes.set(value.path, {
			path: value.path,
			text: value.text,
			createdAt: notes.get(value.path)?.createdAt ?? entry.timestamp,
			updatedAt: entry.timestamp,
		});
	}
	return notes;
}
export function resolveNotePath(
	path: string,
	currentAgent: string,
	allowDirectory = false,
): { agentName: string; path: string } {
	const absolute = path.startsWith("/") ? path : `${currentAgent}/notes${path ? `/${path}` : ""}`;
	const parts = absolute.slice(1).split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0")))
		throw new Error("Use a virtual note path without empty, dot, or parent components");
	const split = parts.indexOf("notes");
	if (split < 1 || (!allowDirectory && split === parts.length - 1)) throw new Error("Expected <agent>/notes/<path>");
	return { agentName: `/${parts.slice(0, split).join("/")}`, path: parts.slice(split + 1).join("/") };
}
export function messageKey(message: AgentMessage): string {
	return `${message.role}:${message.timestamp}:${message.role === "toolResult" ? message.toolCallId : ""}`;
}
export function initialWindowId(sessionId: string, entries: readonly SessionEntry[] = []): string {
	const origin = entries.find((entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY);
	if (origin?.type === "custom" && isRecord(origin.data) && typeof origin.data.id === "string") return origin.data.id;
	return `${sessionId}:0`;
}

export function checkpoint(entries: readonly SessionEntry[]): string {
	const notes = [...readNotes(entries).values()];
	// Keep the recovery prefix bounded; larger notes remain available through notes.read_file.
	const excerpts = notes
		.map((note) => `${note.path}\n${note.text.slice(0, 12000)}`)
		.join("\n\n")
		.slice(0, 24000);
	const latest = latestWindow(entries);
	const requests = entries.slice(latest ? latest.index + 1 : 0).flatMap((entry) => {
		if (entry.type === "message" && entry.message.role === "user")
			return [
				{
					id: entry.id,
					text:
						typeof entry.message.content === "string"
							? entry.message.content
							: entry.message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
				},
			];
		if (entry.type === "custom_message" && entry.customType === "subagent-task")
			return [{ id: entry.id, text: typeof entry.content === "string" ? entry.content : "" }];
		return [];
	});
	return [
		latest?.state.checkpoint.slice(0, 12000),
		requests
			.map((request) => `[id: ${request.id}] ${request.text.slice(0, 6000)}`)
			.join("\n")
			.slice(-12000),
		excerpts,
	]
		.filter(Boolean)
		.join("\n\n")
		.slice(-36000);
}
