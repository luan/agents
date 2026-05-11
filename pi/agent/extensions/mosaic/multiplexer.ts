import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Heartbeat } from "./mux-heartbeat.js";
import { listActive } from "./mux-heartbeat.js";
import { spawnInCurrentSessionWindow } from "./mux-swap.js";

export type MultiplexerBackend = "tmux" | "zellij";

export interface MultiplexerTarget {
	backend: MultiplexerBackend;
	paneId: string;
	windowId?: string;
	windowName?: string;
	tmuxSession?: string;
	zellijSession?: string;
	zellijTabId?: string;
	zellijTabName?: string;
	zellijSessionOwned?: boolean;
}

export interface LaunchOptions {
	command: string;
	cwd: string;
	owner: string;
	name: string;
	agentId: string;
	extraEnv?: Record<string, string>;
}

const READY_DIR = join(tmpdir(), "mosaic-ready");

export function getMultiplexerBackend(): MultiplexerBackend | undefined {
	if (process.env.TMUX && process.env.TMUX_PANE) return "tmux";
	if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME || process.env.ZELLIJ_PANE_ID) return "zellij";
	if (zellijInstalled()) return "zellij";
	return undefined;
}

export function requireMultiplexerBackend(): MultiplexerBackend {
	const backend = getMultiplexerBackend();
	if (!backend) {
		throw new Error("Mosaic requires tmux or an active zellij session for full-session background agents.");
	}
	return backend;
}

export function currentMultiplexerTarget(): Partial<MultiplexerTarget> {
	const backend = getMultiplexerBackend();
	if (backend === "tmux") {
		const paneId = process.env.TMUX_PANE;
		return {
			backend,
			paneId,
			tmuxSession: paneId ? tmuxFormat(paneId, "#{session_id}") : undefined,
			windowId: paneId ? tmuxFormat(paneId, "#{window_id}") : undefined,
			windowName: paneId ? tmuxFormat(paneId, "#{window_name}") : undefined,
		};
	}
	if (backend === "zellij") {
		const info = readCurrentZellijTabInfo();
		return {
			backend,
			paneId: normalizeZellijPaneId(process.env.ZELLIJ_PANE_ID),
			zellijSession: process.env.ZELLIJ_SESSION_NAME,
			zellijTabId: info?.id,
			zellijTabName: info?.name,
			zellijSessionOwned: process.env.MOSAIC_ZELLIJ_SESSION_OWNED === "1",
			windowId: info?.id,
			windowName: info?.name,
		};
	}
	return {};
}

export function launchMosaicTarget(options: LaunchOptions): MultiplexerTarget {
	const backend = requireMultiplexerBackend();
	if (backend === "tmux") {
		const spawned = spawnInCurrentSessionWindow(
			options.command,
			options.cwd,
			options.owner,
			options.name,
			options.extraEnv ?? {},
		);
		return {
			backend,
			paneId: spawned.paneId,
			windowId: spawned.windowId,
			windowName: options.name,
			tmuxSession: spawned.tmuxSession,
		};
	}
	return launchZellijTarget(options);
}

export function focusTarget(target: Heartbeat): void {
	if (target.backend === "zellij") {
		if (target.zellijSession && target.zellijSession !== process.env.ZELLIJ_SESSION_NAME) {
			execFileSync("zellij", [
				"action",
				"switch-session",
				...(target.paneId ? ["--pane-id", target.paneId] : []),
				target.zellijSession,
			]);
			return;
		}
		if (target.zellijTabId) {
			execFileSync("zellij", zellijActionArgs(target, "go-to-tab-by-id", target.zellijTabId));
			return;
		}
		if (target.zellijTabName) {
			execFileSync("zellij", zellijActionArgs(target, "go-to-tab-name", target.zellijTabName));
			return;
		}
		if (target.paneId) execFileSync("zellij", zellijActionArgs(target, "focus-pane-id", target.paneId));
		return;
	}
	if (target.windowId) {
		execFileSync("tmux", ["select-window", "-t", target.windowId]);
		return;
	}
	execFileSync("tmux", ["swap-pane", "-s", target.paneId, "-t", process.env.TMUX_PANE ?? ""]);
}

export function killTarget(target: Heartbeat): void {
	if (target.backend === "zellij") {
		if (target.zellijSessionOwned && target.zellijSession) {
			execFileSync("zellij", ["kill-session", target.zellijSession]);
			return;
		}
		if (target.zellijTabId) {
			execFileSync("zellij", zellijActionArgs(target, "close-tab-by-id", target.zellijTabId));
			return;
		}
		if (target.paneId) {
			execFileSync("zellij", zellijActionArgs(target, "focus-pane-id", target.paneId));
			execFileSync("zellij", zellijActionArgs(target, "close-pane"));
		}
		return;
	}
	execFileSync("tmux", ["kill-pane", "-t", target.paneId]);
}

export function sendMessageToTarget(target: Heartbeat, message: string): void {
	if (target.backend === "zellij") {
		execFileSync("zellij", zellijActionArgs(target, "write-chars", "--pane-id", target.paneId, "--", message));
		execFileSync("zellij", zellijActionArgs(target, "write-chars", "--pane-id", target.paneId, "\r"));
		return;
	}
	const bufferName = `mosaic-${randomUUID()}`;
	execFileSync("tmux", ["set-buffer", "-b", bufferName, message]);
	try {
		execFileSync("tmux", ["paste-buffer", "-b", bufferName, "-t", target.paneId]);
		execFileSync("tmux", ["send-keys", "-t", target.paneId, "Enter"]);
	} finally {
		try {
			execFileSync("tmux", ["delete-buffer", "-b", bufferName], { stdio: "ignore" });
		} catch {}
	}
}

function launchZellijTarget(options: LaunchOptions): MultiplexerTarget {
	const insideZellij = Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME || process.env.ZELLIJ_PANE_ID);
	const zellijSession = insideZellij ? process.env.ZELLIJ_SESSION_NAME : `mosaic-${options.agentId}`;
	if (!insideZellij) execFileSync("zellij", ["attach", "--create-background", zellijSession]);
	mkdirSync(READY_DIR, { recursive: true });
	const readyFile = join(READY_DIR, randomUUID());
	const env = {
		MOSAIC_OWNER: options.owner,
		MOSAIC_READY_FILE: readyFile,
		...(insideZellij ? {} : { MOSAIC_ZELLIJ_SESSION_OWNED: "1" }),
		...(options.extraEnv ?? {}),
	};
	const shellCommand = `${formatEnv(env)} exec ${options.command}`;
	const tabId = execFileSync(
		"zellij",
		[
			...(zellijSession ? ["--session", zellijSession] : []),
			"action",
			"new-tab",
			"--name",
			options.name,
			"--cwd",
			options.cwd,
			"--",
			"sh",
			"-lc",
			shellCommand,
		],
		{ encoding: "utf8" },
	).trim();

	waitForReadyFile(readyFile, 5000);
	try {
		rmSync(readyFile, { force: true });
	} catch {}

	const live = listActive().find((entry) => entry.agentId === options.agentId);
	return {
		backend: "zellij",
		paneId: live?.paneId ?? "",
		windowId: tabId,
		windowName: options.name,
		zellijSession,
		zellijTabId: tabId,
		zellijTabName: options.name,
		zellijSessionOwned: !insideZellij,
	};
}

function zellijActionArgs(target: Heartbeat, ...args: string[]): string[] {
	return [...(target.zellijSession ? ["--session", target.zellijSession] : []), "action", ...args];
}

function zellijInstalled(): boolean {
	try {
		execFileSync("zellij", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function tmuxFormat(target: string, format: string): string | undefined {
	try {
		return execFileSync("tmux", ["display-message", "-t", target, "-p", format], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function readCurrentZellijTabInfo(): { id?: string; name?: string } | undefined {
	try {
		const raw = execFileSync("zellij", ["action", "current-tab-info", "--json"], { encoding: "utf8" });
		const parsed = JSON.parse(raw) as { id?: number | string; name?: string };
		return {
			id: parsed.id == null ? undefined : String(parsed.id),
			name: typeof parsed.name === "string" ? parsed.name : undefined,
		};
	} catch {
		return undefined;
	}
}

function normalizeZellijPaneId(paneId: string | undefined): string | undefined {
	if (!paneId) return undefined;
	return paneId.startsWith("terminal_") || paneId.startsWith("plugin_") ? paneId : `terminal_${paneId}`;
}

function formatEnv(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function waitForReadyFile(path: string, timeoutMs: number): void {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		sleepMs(10);
	}
	throw new Error("Timed out waiting for zellij mosaic tab to start.");
}

function sleepMs(ms: number): void {
	const sab = new SharedArrayBuffer(4);
	const view = new Int32Array(sab);
	Atomics.wait(view, 0, 0, ms);
}
