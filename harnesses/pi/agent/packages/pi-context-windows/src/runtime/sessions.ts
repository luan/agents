import { archivedHistory } from "../core/archives.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isRecord, type JsonValue, type SessionIdentity, sessionIdentity } from "../core/state.ts";

export interface SessionAccess {
	id: string;
	identity: SessionIdentity;
	entries(): SessionEntry[];
	historyEntries?(): SessionEntry[];
	append(type: string, data: JsonValue): void;
}
const SESSIONS = Symbol.for("pi-context/sessions/v1");
// type-boundary: independently bundled copies share a versioned registry; validate its Map methods before use.
type RegistryValue = unknown;
function directory(): Map<string, SessionAccess> {
	const slots = globalThis as Record<symbol, RegistryValue>;
	const candidate = slots[SESSIONS] as Partial<Map<string, SessionAccess>> | undefined;
	if (
		candidate &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.values === "function"
	)
		return candidate as Map<string, SessionAccess>;
	const created = new Map<string, SessionAccess>();
	slots[SESSIONS] = created;
	return created;
}
export function bindSession(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager">,
): () => void {
	const id = ctx.sessionManager.getSessionId();
	const access: SessionAccess = {
		id,
		identity: sessionIdentity(ctx.sessionManager.getBranch(), id),
		entries: () => ctx.sessionManager.getBranch(),
		historyEntries: () => archivedHistory(ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch()),
		append: (type, data) => pi.appendEntry(type, data),
	};
	directory().set(id, access);
	return () => {
		if (directory().get(id) === access) directory().delete(id);
	};
}
export async function resolveSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
	name?: string | null,
): Promise<SessionAccess> {
	const id = ctx.sessionManager.getSessionId();
	const identity = sessionIdentity(ctx.sessionManager.getBranch(), id);
	const agentName = !name ? identity.agentName : name.startsWith("/") ? name : `${identity.agentName}/${name}`;
	if (!/^\/root(?:\/[a-zA-Z0-9_-]+)*$/.test(agentName)) throw new Error("Invalid agent name");
	for (const access of directory().values())
		if (access.identity.rootSessionId === identity.rootSessionId && access.identity.agentName === agentName)
			return access;
	// Follow persisted tree checkpoints across working directories, then check identity before exposing a transcript.
	const rootEntries =
		directory().get(identity.rootSessionId)?.entries() ??
		(identity.rootSessionFile
			? SessionManager.open(identity.rootSessionFile).getBranch()
			: ctx.sessionManager.getBranch());
	const files = new Set<string>();
	if (identity.rootSessionFile) files.add(identity.rootSessionFile);
	for (const entry of rootEntries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:agent-v1") continue;
		const data = entry.data;
		if (isRecord(data) && data.version === 1 && isRecord(data.agent) && typeof data.agent.transcriptFile === "string")
			files.add(data.agent.transcriptFile);
	}
	const dir = ctx.sessionManager.getSessionDir();
	for (const entry of await readdir(dir, { withFileTypes: true }))
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(join(dir, entry.name));
	for (const file of files) {
		const manager = SessionManager.open(file);
		const targetId = manager.getSessionId();
		const target = sessionIdentity(manager.getBranch(), targetId);
		if (target.rootSessionId !== identity.rootSessionId || target.agentName !== agentName) continue;
		const live = directory().get(targetId);
		if (live) return live;
		const access: SessionAccess = {
			id: targetId,
			identity: target,
			entries: () => manager.getBranch(),
			historyEntries: () => archivedHistory(manager.getEntries(), manager.getBranch()),
			append: (type, data) => manager.appendCustomEntry(type, data),
		};
		directory().set(targetId, access);
		return access;
	}
	throw new Error(`Agent ${agentName} is unavailable in this session tree`);
}
