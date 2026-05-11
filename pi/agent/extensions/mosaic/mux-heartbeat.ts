import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Heartbeat {
	backend?: "tmux" | "zellij";
	paneId: string;
	sessionFile: string;
	cwd: string;
	pid: number;
	owner: string;
	busy: boolean;
	/** tmux session id/name containing this pane. */
	tmuxSession?: string;
	/** tmux window id containing this pane. */
	windowId?: string;
	/** tmux window name containing this pane. */
	windowName?: string;
	/** zellij session name containing this pane. */
	zellijSession?: string;
	/** zellij tab id containing this pane. */
	zellijTabId?: string;
	/** zellij tab name containing this pane. */
	zellijTabName?: string;
	/** Whether this Pi process owns the whole zellij session. */
	zellijSessionOwned?: boolean;
	/** Session display name (user-set via /name) or first user message. */
	label?: string;
	/** Path of the session this one was forked from, if any. */
	parentSessionFile?: string;
	/** Full-session subagent id, when this pane was launched by the Agent tool. */
	agentId?: string;
	/** Full-session subagent type, when known. */
	agentType?: string;
	/** Full-session subagent description, when known. */
	agentDescription?: string;
}

const DIR = join(homedir(), ".mosaic", "heartbeats");
const INTERVAL_MS = 2000;
const STALE_MS = 5000;

function filePath(paneId: string): string {
	return join(DIR, `${paneId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

let currentPath: string | undefined;
let currentEntry: Heartbeat | undefined;
let tickHandle: ReturnType<typeof setInterval> | undefined;

export function start(entry: Heartbeat): void {
	mkdirSync(DIR, { recursive: true });
	currentPath = filePath(entry.paneId);
	currentEntry = entry;
	writeCurrent();
	const tick = setInterval(() => {
		if (!currentPath) return;
		const now = new Date();
		try {
			utimesSync(currentPath, now, now);
		} catch {
			writeCurrent();
		}
	}, INTERVAL_MS);
	if (typeof tick.unref === "function") tick.unref();
	tickHandle = tick;
}

export function setBusy(busy: boolean): void {
	if (!currentEntry) return;
	if (currentEntry.busy === busy) return;
	currentEntry = { ...currentEntry, busy };
	writeCurrent();
}

export function setLabel(label: string | undefined): void {
	if (!currentEntry) return;
	const next = label?.trim() ? label.trim() : undefined;
	if (currentEntry.label === next) return;
	currentEntry = { ...currentEntry, label: next };
	writeCurrent();
}

function writeCurrent(): void {
	if (!currentPath || !currentEntry) return;
	try {
		writeFileSync(currentPath, JSON.stringify(currentEntry));
	} catch {}
}

export function stop(): void {
	if (tickHandle) {
		clearInterval(tickHandle);
		tickHandle = undefined;
	}
	if (currentPath) {
		try {
			unlinkSync(currentPath);
		} catch {}
		currentPath = undefined;
	}
	currentEntry = undefined;
}

/** Pi slots with fresh heartbeat + live pid. Stale files are unlinked. */
export function listActive(): Heartbeat[] {
	const cutoff = Date.now() - STALE_MS;
	const result: Heartbeat[] = [];
	for (const name of readDirSafe()) {
		const full = join(DIR, name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(full).mtimeMs;
		} catch {
			continue;
		}
		const data = readEntry(full);
		const fresh = mtimeMs >= cutoff;
		if (!data || !pidAlive(data.pid) || !fresh) {
			try {
				unlinkSync(full);
			} catch {}
			continue;
		}
		result.push(data);
	}
	return result;
}

function readDirSafe(): string[] {
	if (!existsSync(DIR)) return [];
	try {
		return readdirSync(DIR);
	} catch {
		return [];
	}
}

function readEntry(full: string): Heartbeat | undefined {
	try {
		const data = JSON.parse(readFileSync(full, "utf8")) as Partial<Heartbeat>;
		if (
			typeof data.paneId === "string" &&
			typeof data.sessionFile === "string" &&
			typeof data.cwd === "string" &&
			typeof data.pid === "number" &&
			typeof data.owner === "string"
		) {
			return {
				backend: data.backend === "zellij" ? "zellij" : data.backend === "tmux" ? "tmux" : undefined,
				paneId: data.paneId,
				sessionFile: data.sessionFile,
				cwd: data.cwd,
				pid: data.pid,
				owner: data.owner,
				busy: typeof data.busy === "boolean" ? data.busy : false,
				tmuxSession: typeof data.tmuxSession === "string" ? data.tmuxSession : undefined,
				windowId: typeof data.windowId === "string" ? data.windowId : undefined,
				windowName: typeof data.windowName === "string" ? data.windowName : undefined,
				zellijSession: typeof data.zellijSession === "string" ? data.zellijSession : undefined,
				zellijTabId: typeof data.zellijTabId === "string" ? data.zellijTabId : undefined,
				zellijTabName: typeof data.zellijTabName === "string" ? data.zellijTabName : undefined,
				zellijSessionOwned: data.zellijSessionOwned === true,
				label: typeof data.label === "string" ? data.label : undefined,
				parentSessionFile: typeof data.parentSessionFile === "string" ? data.parentSessionFile : undefined,
				agentId: typeof data.agentId === "string" ? data.agentId : undefined,
				agentType: typeof data.agentType === "string" ? data.agentType : undefined,
				agentDescription: typeof data.agentDescription === "string" ? data.agentDescription : undefined,
			};
		}
	} catch {
		try {
			unlinkSync(full);
		} catch {}
	}
	return undefined;
}

function pidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
