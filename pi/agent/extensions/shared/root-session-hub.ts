import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	installRuntimeHubShortcutPatch,
	type RuntimeHubEntry,
	type RuntimeHubScope,
	registerRuntimeHubSource,
} from "./runtime-hub";

const subagentSessionDir = join(getAgentDir(), "sessions", "subagents");
const savedSessionRefreshMs = 30_000;
const savedSessionCaches = new Map<string, { refreshedAt: number; sessions: SessionInfo[] }>();
const savedSessionRefreshes = new Map<string, Promise<void>>();

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
	const commandCtx = ctx as ExtensionContext & {
		switchSession?: (sessionPath: string, options?: unknown) => Promise<void>;
	};
	const cachedSessions = savedSessionCaches.get(savedSessionCacheKey(ctx, scope))?.sessions ?? [];
	const sessions = new Map(cachedSessions.map((session) => [session.id, session]));
	if (!sessions.has(currentId)) {
		sessions.set(currentId, {
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

	return [...sessions.values()]
		.filter((session) => {
			if (scope === "current") return session.id === currentId;
			if (scope === "project") return session.cwd === ctx.cwd;
			return true;
		})
		.map((session) => {
			const current = session.id === currentId;
			const entry: RuntimeHubEntry = {
				key: `session:${session.id}`,
				kind: "session",
				label: session.name || session.firstMessage || basename(session.cwd) || session.id.slice(0, 8),
				status: current ? "current" : "saved",
				description: description(session),
				lastActivity: session.modified.getTime(),
				open: async () => {
					if (current || !session.path) return;
					if (typeof commandCtx.switchSession !== "function") {
						throw new Error("Open Hub with /hub to switch sessions.");
					}
					await commandCtx.switchSession(session.path);
				},
			};
			return entry;
		});
}

const source = {
	async refresh(ctx: ExtensionContext, scope: RuntimeHubScope): Promise<void> {
		if (!ctx.sessionManager || scope === "current") return;
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

export function registerRootSessionHub(): () => void {
	installRuntimeHubShortcutPatch();
	return registerRuntimeHubSource("root-sessions", source);
}
