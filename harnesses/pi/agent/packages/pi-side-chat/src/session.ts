import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionContext,
	type SessionEntry,
	type Theme,
	SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { createTuiThemeVariation } from "pi-libtui";
import type { SideChatStateTab } from "./state.ts";

export const SIDE_CONVERSATION_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread. If there is no user question after this boundary yet, wait for one.

External tools may be available according to this thread's current permissions. Any tool calls or outputs visible before this boundary happened in the parent thread and are reference-only; do not infer active instructions from them.

Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary.

Do not modify files, source, git state, permissions, configuration, or workspace state unless the user explicitly asks for that mutation after this boundary. Do not request escalated permissions or broader sandbox access unless the user explicitly asks for a mutation that requires it. If the user explicitly requests a mutation, keep it minimal, local to the request, and avoid disrupting the main thread.`;

export interface SideChatRuntime {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly theme: Theme;
	inheritedEntries(): readonly SessionEntry[];
	readonly parentSession?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
	writeSession(session: SideChatSessionWrite): void;
}

export interface SideChatSessionWrite {
	readonly cwd: string;
	readonly sessionDir: string;
	readonly sessionId: string;
	readonly label: string;
	readonly themePath: string;
	readonly themeJson: string;
	readonly inheritedEntries: readonly SessionEntry[];
	readonly parentSession?: string;
}

export interface SideChatCommandOptions {
	readonly sessionDir: string;
	readonly themeName: string;
	readonly themePath: string;
	readonly tab: SideChatStateTab;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly prompt?: string;
}

export function createSideChatRuntime(
	context: ExtensionContext,
	writeSession: (session: SideChatSessionWrite) => void,
): SideChatRuntime {
	const parentSession = context.sessionManager.getSessionFile();
	return {
		cwd: context.cwd,
		sessionRoot: sideChatSessionRoot(context),
		theme: context.ui.theme,
		inheritedEntries: () => context.sessionManager.getBranch().filter(participatesInModelContext),
		writeSession,
		...(parentSession ? { parentSession } : {}),
		...(context.model ? { model: `${context.model.provider}/${context.model.id}` } : {}),
		...(context.thinkingLevel ? { thinkingLevel: context.thinkingLevel } : {}),
	};
}

export function sideChatSessionRoot(context: ExtensionContext): string {
	if (context.sessionManager.getSessionFile()) return context.sessionManager.getSessionDir();
	return join(tmpdir(), "pi-side-chat", context.sessionManager.getSessionId());
}

/** Create the child session and theme before its PTY command can start. */
export function prepareSideChatSession(
	runtime: SideChatRuntime,
	tab: SideChatStateTab,
	prompt?: string,
): SideChatCommandOptions {
	const options = sideChatCommandOptions(runtime, tab, prompt);
	runtime.writeSession({
		cwd: runtime.cwd,
		sessionDir: options.sessionDir,
		sessionId: tab.sessionId,
		label: tab.label,
		themePath: options.themePath,
		themeJson: `${JSON.stringify(createTuiThemeVariation(runtime.theme, options.themeName), null, 2)}\n`,
		inheritedEntries: runtime.inheritedEntries(),
		...(runtime.parentSession ? { parentSession: runtime.parentSession } : {}),
	});
	return options;
}

export function writeSideChatSession(session: SideChatSessionWrite): void {
	mkdirSync(session.sessionDir, { recursive: true });
	writeFileSync(session.themePath, session.themeJson);
	const manager = SessionManager.create(session.cwd, session.sessionDir, {
		id: session.sessionId,
		...(session.parentSession ? { parentSession: session.parentSession } : {}),
	});
	manager.appendSessionInfo(session.label);
	const sessionFile = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionFile || !header) throw new Error("Pi did not allocate the side-chat session file");
	const sessionInfo = manager.getEntries()[0];
	if (!sessionInfo) throw new Error("Pi did not allocate the side-chat session label");
	const inheritedEntries = reparentEntries(session.inheritedEntries, sessionInfo.id);
	writeFileSync(
		sessionFile,
		`${[header, sessionInfo, ...inheritedEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	const fork = SessionManager.open(sessionFile, session.sessionDir);
	fork.appendCustomMessageEntry("pi-side-chat-boundary", SIDE_CONVERSATION_BOUNDARY, false);
}

export function createSideChatCommand(options: SideChatCommandOptions): string {
	const { sessionDir, themeName, themePath, tab, model, thinkingLevel, prompt } = options;
	const args = [
		"pi",
		"--tui-mode",
		"fullscreen",
		"--session-dir",
		sessionDir,
		"--session-id",
		tab.sessionId,
		"--theme",
		themePath,
		"--use-theme",
		themeName,
	];
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (prompt) args.push("--", prompt);
	return `PI_EMBEDDED_SIDE_CHAT=1 ${args.map(shellQuote).join(" ")}`;
}

export function resumeSideChatCommand(runtime: SideChatRuntime, tab: SideChatStateTab): string {
	return createSideChatCommand(sideChatCommandOptions(runtime, tab));
}

function sideChatCommandOptions(
	runtime: SideChatRuntime,
	tab: SideChatStateTab,
	prompt?: string,
): SideChatCommandOptions {
	const sessionDir = sideChatSessionDir(runtime.sessionRoot, tab.sessionId);
	const themeName = `side-chat-${tab.sessionId}`;
	return {
		sessionDir,
		themeName,
		themePath: join(sessionDir, `${themeName}.json`),
		tab,
		...(runtime.model ? { model: runtime.model } : {}),
		...(runtime.thinkingLevel ? { thinkingLevel: runtime.thinkingLevel } : {}),
		...(prompt ? { prompt } : {}),
	};
}

function sideChatSessionDir(rootSessionDir: string, sessionId: string): string {
	return join(rootSessionDir, "side-chats", sessionId);
}

function participatesInModelContext(entry: SessionEntry): boolean {
	return sessionEntryToContextMessages(entry).length > 0;
}

function reparentEntries(entries: readonly SessionEntry[], firstParentId: string): SessionEntry[] {
	let parentId: string | null = firstParentId;
	return entries.map((entry) => {
		const reparented = { ...entry, parentId };
		parentId = entry.id;
		return reparented;
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
