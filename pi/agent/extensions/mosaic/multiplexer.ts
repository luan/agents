import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LanePlacementRequest,
	TmuxLanePlacement,
	type TmuxLanePlacementRef,
	ZellijLanePlacement,
	type ZellijLanePlacementRef,
} from "../shared/lane-placement.js";
import type { Heartbeat } from "./mux-heartbeat.js";
import { listActive } from "./mux-heartbeat.js";
import { resolveShell } from "./mux-swap.js";

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
	placement?: TmuxLanePlacementRef | ZellijLanePlacementRef;
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

interface LaunchDependencies {
	backend?: () => MultiplexerBackend;
	tmuxPlace?: (request: LanePlacementRequest) => Promise<TmuxLanePlacementRef>;
	zellijPlace?: (request: LanePlacementRequest) => Promise<ZellijLanePlacementRef>;
	listActive?: () => Heartbeat[];
	waitForReadyFile?: (path: string, timeoutMs: number) => void;
	execFileSync?: typeof execFileSync;
}

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

export async function launchMosaicTarget(
	options: LaunchOptions,
	dependencies: LaunchDependencies = {},
): Promise<MultiplexerTarget> {
	const backend = dependencies.backend?.() ?? requireMultiplexerBackend();
	return backend === "tmux" ? launchTmuxTarget(options, dependencies) : launchZellijTarget(options, dependencies);
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

async function launchTmuxTarget(options: LaunchOptions, dependencies: LaunchDependencies): Promise<MultiplexerTarget> {
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("not in tmux");
	const liveBeforeLaunch = (dependencies.listActive ?? listActive)();
	const placementPlan = mosaicSplitPlacement(options, liveBeforeLaunch, pane);
	const { readyFile, env } = prepareLaunchEnvironment(options, { includeShell: true });
	const placement = await (dependencies.tmuxPlace ?? defaultTmuxPlace)({
		placement: "split-pane",
		cwd: options.cwd,
		name: options.name,
		command: options.command,
		env,
		targetPane: placementPlan.targetPane,
		splitDirection: placementPlan.splitDirection,
	});
	waitForLaunchReady(readyFile, dependencies);
	const live = (dependencies.listActive ?? listActive)().find((entry) => entry.agentId === options.agentId);
	return {
		backend: "tmux",
		paneId: live?.paneId ?? placement.tmux.paneId ?? "",
		windowId: live?.windowId ?? placement.tmux.windowId,
		windowName: live?.windowName ?? options.name,
		tmuxSession: live?.tmuxSession ?? placement.tmux.session,
		placement,
	};
}

async function defaultTmuxPlace(request: LanePlacementRequest): Promise<TmuxLanePlacementRef> {
	return new TmuxLanePlacement({
		exec: async (args) =>
			execFileSync("tmux", args, {
				encoding: "utf8",
			}).trim(),
	}).place(request);
}

async function launchZellijTarget(
	options: LaunchOptions,
	dependencies: LaunchDependencies,
): Promise<MultiplexerTarget> {
	const insideZellij = Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME || process.env.ZELLIJ_PANE_ID);
	const zellijSession = insideZellij ? process.env.ZELLIJ_SESSION_NAME : `mosaic-${options.agentId}`;
	const { readyFile, env } = prepareLaunchEnvironment(options, {
		sessionOwned: !insideZellij,
	});
	const liveBeforeLaunch = (dependencies.listActive ?? listActive)();
	const placementPlan = insideZellij
		? mosaicSplitPlacement(options, liveBeforeLaunch, normalizeZellijPaneId(process.env.ZELLIJ_PANE_ID))
		: undefined;
	const placement = await (dependencies.zellijPlace ?? defaultZellijPlace)({
		placement: insideZellij ? "split-pane" : "hidden",
		cwd: options.cwd,
		name: options.name,
		command: options.command,
		env,
		targetWorkspace: zellijSession,
		targetPane: placementPlan?.targetPane,
		splitDirection: placementPlan?.splitDirection,
	});
	waitForLaunchReady(readyFile, dependencies);
	const live = (dependencies.listActive ?? listActive)().find((entry) => entry.agentId === options.agentId);
	return {
		backend: "zellij",
		paneId: live?.paneId ?? placement.zellij.paneId ?? "",
		windowId: live?.windowId ?? placement.zellij.tabId,
		windowName: live?.windowName ?? options.name,
		zellijSession: live?.zellijSession ?? placement.zellij.session ?? zellijSession,
		zellijTabId: live?.zellijTabId ?? placement.zellij.tabId,
		zellijTabName: live?.zellijTabName ?? placement.zellij.tabName ?? options.name,
		zellijSessionOwned: live?.zellijSessionOwned ?? placement.zellij.sessionOwned ?? !insideZellij,
		placement,
	};
}

async function defaultZellijPlace(request: LanePlacementRequest): Promise<ZellijLanePlacementRef> {
	return new ZellijLanePlacement({
		exec: async (args) =>
			execFileSync("zellij", args, {
				encoding: "utf8",
			}).trim(),
	}).place(request);
}

function mosaicSplitPlacement(
	options: LaunchOptions,
	live: Heartbeat[],
	defaultPane: string | undefined,
): { targetPane?: string; splitDirection: "horizontal" | "vertical" } {
	const firstAgent = live
		.filter((entry) => entry.agentId && entry.owner === options.owner && entry.paneId)
		.sort((a, b) => paneSortKey(a.paneId) - paneSortKey(b.paneId))[0];
	if (firstAgent?.paneId) return { targetPane: firstAgent.paneId, splitDirection: "vertical" };
	return { targetPane: defaultPane, splitDirection: "horizontal" };
}

function paneSortKey(paneId: string): number {
	const match = paneId.match(/\d+/);
	return match ? Number.parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER;
}

function prepareLaunchEnvironment(
	options: LaunchOptions,
	config: { includeShell?: boolean; sessionOwned?: boolean },
): { readyFile: string; env: Record<string, string> } {
	mkdirSync(READY_DIR, { recursive: true });
	const readyFile = join(READY_DIR, randomUUID());
	return {
		readyFile,
		env: {
			MOSAIC_OWNER: options.owner,
			MOSAIC_READY_FILE: readyFile,
			...(config.includeShell ? { MOSAIC_SHELL: resolveShell() } : {}),
			...(config.sessionOwned ? { MOSAIC_ZELLIJ_SESSION_OWNED: "1" } : {}),
			...(options.extraEnv ?? {}),
		},
	};
}

function waitForLaunchReady(path: string, dependencies: LaunchDependencies): void {
	(dependencies.waitForReadyFile ?? waitForReadyFile)(path, 5000);
	try {
		rmSync(path, { force: true });
	} catch {}
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
