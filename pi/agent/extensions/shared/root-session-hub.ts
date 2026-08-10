import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	attachRuntimeTerminal,
	installRuntimeHubShortcutPatch,
	type RuntimeAttachment,
	type RuntimeHubEntry,
	type RuntimeHubScope,
	registerRuntimeHubSource,
} from "./runtime-hub";

interface LiveRootSession {
	pid: number;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	name?: string;
	updatedAt: number;
	attachment: RuntimeAttachment;
}

const registryDir = join(homedir(), ".pi", "agent", "runtime-hub", "roots");
const subagentSessionDir = join(getAgentDir(), "sessions", "subagents");
const heartbeatGraceMs = 30_000;
const savedSessionRefreshMs = 30_000;
const savedSessionCaches = new Map<string, { refreshedAt: number; sessions: SessionInfo[] }>();
const savedSessionRefreshes = new Map<string, Promise<void>>();
let liveSessions: LiveRootSession[] = [];
let recordPath: string | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLiveSessions(): LiveRootSession[] {
	if (!existsSync(registryDir)) return [];
	const result: LiveRootSession[] = [];
	for (const name of readdirSync(registryDir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(registryDir, name);
		try {
			const record = JSON.parse(readFileSync(path, "utf8")) as LiveRootSession;
			if (!isAlive(record.pid) || Date.now() - record.updatedAt > heartbeatGraceMs) {
				unlinkSync(path);
				continue;
			}
			result.push(record);
		} catch {
			try {
				unlinkSync(path);
			} catch {}
		}
	}
	return result;
}

function writeLiveRecord(ctx: ExtensionContext): void {
	if (process.env.PI_ATTACHED_AGENT) return;
	const sessionName = process.env.PI_ROOT_RMUX_SESSION;
	const socketPath = process.env.PI_ROOT_RMUX_SOCKET;
	const configFile = process.env.PI_ROOT_RMUX_CONFIG;
	if (!sessionName || !socketPath || !configFile) return;
	mkdirSync(registryDir, { recursive: true });
	const record: LiveRootSession = {
		pid: process.pid,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
		name: ctx.sessionManager.getSessionName(),
		updatedAt: Date.now(),
		attachment: {
			command: process.env.PI_ROOT_RMUX_BIN || "rmux",
			args: ["-f", configFile, "-S", socketPath, "attach-session", "-t", sessionName],
		},
	};
	recordPath = join(registryDir, `${process.pid}.json`);
	const temporary = `${recordPath}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(temporary, recordPath);
}

function safelyWriteLiveRecord(ctx: ExtensionContext): void {
	try {
		writeLiveRecord(ctx);
	} catch {}
}

function removeLiveRecord(): void {
	if (!recordPath) return;
	try {
		unlinkSync(recordPath);
	} catch {}
	recordPath = undefined;
}

function label(session: SessionInfo, live?: LiveRootSession): string {
	return live?.name || session.name || session.firstMessage || basename(session.cwd) || session.id.slice(0, 8);
}

function description(session: SessionInfo): string {
	return session.firstMessage ? `${session.cwd} · ${session.firstMessage}` : session.cwd;
}

function isSubagentSession(path: string): boolean {
	const candidate = relative(subagentSessionDir, path);
	return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function savedSessionCacheKey(ctx: ExtensionContext, scope: RuntimeHubScope): string {
	return scope === "project" ? `project:${ctx.cwd}` : scope;
}

function sessionEntries(ctx: ExtensionContext, scope: RuntimeHubScope): RuntimeHubEntry[] {
	if (!ctx.sessionManager) return [];
	const currentId = ctx.sessionManager.getSessionId();
	const currentFile = ctx.sessionManager.getSessionFile();
	const commandCtx = ctx as ExtensionCommandContext;
	const liveById = new Map(liveSessions.map((record) => [record.sessionId, record]));
	const cachedSessions = savedSessionCaches.get(savedSessionCacheKey(ctx, scope))?.sessions ?? [];
	const byId = new Map(cachedSessions.map((session) => [session.id, session]));
	for (const live of liveSessions) {
		if (byId.has(live.sessionId)) continue;
		const modified = new Date(live.updatedAt);
		byId.set(live.sessionId, {
			path: live.sessionFile ?? "",
			id: live.sessionId,
			cwd: live.cwd,
			name: live.name,
			created: modified,
			modified,
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		});
	}
	if (!byId.has(currentId)) {
		byId.set(currentId, {
			path: currentFile ?? "",
			id: currentId,
			cwd: ctx.cwd,
			name: ctx.sessionManager.getSessionName(),
			created: new Date(),
			modified: new Date(),
			messageCount: ctx.sessionManager.getBranch().length,
			firstMessage: "",
			allMessagesText: "",
		});
	}
	return [...byId.values()]
		.filter((session) => {
			if (scope === "current") return session.id === currentId;
			if (scope === "project") return session.cwd === ctx.cwd;
			return true;
		})
		.map((session) => {
			const live = liveById.get(session.id);
			const current = session.id === currentId;
			const entry: RuntimeHubEntry = {
				key: `session:${session.id}`,
				kind: "session",
				label: label(session, live),
				status: current ? "current" : live ? "live" : "saved",
				description: description(session),
				lastActivity: Math.max(session.modified.getTime(), live?.updatedAt ?? 0),
				open: async () => {
					if (current || !session.path) return;
					if (readLiveSessions().some((record) => record.sessionId === session.id)) {
						throw new Error("Live session must be attached, not opened twice.");
					}
					if (typeof commandCtx.switchSession !== "function") {
						throw new Error("Open Hub with /hub to switch sessions.");
					}
					await commandCtx.switchSession(session.path);
				},
			};
			if (!current && live) {
				entry.attach = (tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">) =>
					attachRuntimeTerminal(live.attachment, tui);
			}
			return entry;
		});
}

const source = {
	async refresh(ctx: ExtensionContext, scope: RuntimeHubScope): Promise<void> {
		if (!ctx.sessionManager) return;
		liveSessions = readLiveSessions();
		if (scope === "current") return;
		const key = savedSessionCacheKey(ctx, scope);
		const cached = savedSessionCaches.get(key);
		if (cached && Date.now() - cached.refreshedAt <= savedSessionRefreshMs) return;
		const existing = savedSessionRefreshes.get(key);
		if (existing) return existing;
		const refresh = (async () => {
			const listed = scope === "project" ? await SessionManager.list(ctx.cwd) : await SessionManager.listAll();
			savedSessionCaches.set(key, {
				refreshedAt: Date.now(),
				sessions: listed.filter((session) => !isSubagentSession(session.path)),
			});
		})();
		savedSessionRefreshes.set(key, refresh);
		try {
			await refresh;
		} finally {
			if (savedSessionRefreshes.get(key) === refresh) savedSessionRefreshes.delete(key);
		}
	},
	list: sessionEntries,
};

export function registerRootSessionHub(pi: ExtensionAPI): () => void {
	if (process.env.PI_ATTACHED_AGENT) return () => {};
	installRuntimeHubShortcutPatch();
	const unregister = registerRuntimeHubSource("root-sessions", source);
	pi.on("session_start", (_event, ctx) => {
		safelyWriteLiveRecord(ctx);
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => safelyWriteLiveRecord(ctx), 5_000);
		heartbeat.unref();
	});
	pi.on("session_shutdown", () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		removeLiveRecord();
	});
	return () => {
		if (heartbeat) clearInterval(heartbeat);
		removeLiveRecord();
		unregister();
	};
}
