// pi offers only `setActiveTools(names)`, and `_refreshToolRegistry` re-derives the active set on every `registerTool`.
// `install` therefore re-asserts the policy on 5 lifecycle events rather than once.
// A subagent's `tools:` frontmatter allowlist reactivates built-ins the parent hid, so `tool_call` blocks by name too.
// Measured: built-in `grep` returned 15,267 chars per call against `search`'s 2,898, and `bash` ran 322 calls at 13.4% errors.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isCodeModeEnabled } from "../code-mode/mode.ts";
import { activeSessionId, sessionIdFromContext } from "../shared/session-context.ts";
import { AGENT_TOOL_NAMES } from "../subagents/tool-names.ts";
import { ToolReach } from "../token-burden/types.ts";

// pi's built-ins are `read, bash, edit, write, grep, find, ls`; fileops overrides 4 of them by name and these 3 leaked.
export const REPLACED_BUILTIN_TOOLS: Record<string, string> = {
	bash: "use `exec_command`",
	grep: "use `search`",
	ls: "use `find`",
};

// Agent tools stay direct as one family. Two cannot complete in a cell (nested-dispatch.ts:18).
const DEFAULT_DIRECT_TOOLS: readonly string[] = ["exec", "wait", "ask_user", ...AGENT_TOOL_NAMES];

// nested-dispatch.ts:14 refuses `exec` and `wait` inside a cell, so neither has a second path to reach the model.
// A static literal, so the per-extension jiti copies noted below are interchangeable.
export const PINNED_DIRECT_TOOLS = new Set(["exec", "wait"]);

const CONNECTOR_TOOL_PREFIXES = ["mcp__", "codex_apps_"];

export type ToolPolicyConfig = {
	hiddenTools: string[];
	directTools: string[];
	declaredTools: string[];
	deferredTools: string[];
};

export type ToolToggleResult = {
	applied: boolean;
	activeToolNames: string[];
};

type AssignableReach = ToolReach.Direct | ToolReach.Declared | ToolReach.Deferred | ToolReach.Blocked;

type Handler = (...args: any[]) => unknown;

/** The slice of `ExtensionAPI` this module needs. Structural, so no pi import. */
type ToolApi = {
	getActiveTools(): string[];
	setActiveTools(next: string[]): void;
	getAllTools?(): { name: string }[];
	on(event: string, handler: Handler): void;
};

type PromptOptions = {
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
};

/** Code-mode off leaves the cell runner with nothing to run, so `exec` and `wait` are refused rather than idle. */
export function isCellRunnerTool(toolName: string): boolean {
	return toolNameParts(toolName.toLowerCase()).some((part) => PINNED_DIRECT_TOOLS.has(part));
}

// A `tool_search` hit has to be callable on the next turn, which is codex's `defer_loading: true`
// (codex-rs/tools/src/tool_search.rs:37-71). Session-scoped and in memory: promoting must not write
// tool-policy/config.json, which stays byte-identical across a toggle.
const PROMOTED_TOOLS = Symbol.for("agents.promotedToolsBySession");
const promotedState = globalThis as typeof globalThis & Record<symbol, Map<string, Set<string>> | undefined>;
const PROMOTED_BY_SESSION = promotedState[PROMOTED_TOOLS] ?? new Map<string, Set<string>>();
promotedState[PROMOTED_TOOLS] = PROMOTED_BY_SESSION;
const DEFAULT_SESSION = "default";

function sessionKey(sessionId?: string): string {
	return sessionId ?? activeSessionId() ?? DEFAULT_SESSION;
}

function promotedTools(sessionId?: string): Set<string> {
	const key = sessionKey(sessionId);
	const existing = PROMOTED_BY_SESSION.get(key);
	if (existing) return existing;
	const promoted = new Set<string>();
	PROMOTED_BY_SESSION.set(key, promoted);
	return promoted;
}

// 2 x `RESULT_LIMIT` (tool-search.ts:21), so two consecutive full searches coexist and neither evicts the other.
// Measured over 1,065 sessions: 42 called a connector tool at all, and distinct connector tools per session ran
// p50 2, p75 3, p90 4, p95 5, p99 13, max 13 — so 16 never evicts anything the corpus actually did. Not derived from
// codex, which has no promotion cap: its exposure is static (core/src/tools/handlers/dynamic.rs:76) and found
// declarations ride in history until compaction drops them (core/src/compact_remote.rs:483-500).
// Costs about 400 resident tokens per promoted tool (89,893 for a 224-tool dump), so 6,400 against 89,893.
// A Set iterates in insertion order, so re-promoting moves a name to the back and the oldest falls off the front.
const MAX_PROMOTED_TOOLS = 16;

function isPromotedTool(toolName: string, sessionId?: string): boolean {
	const promoted = promotedTools(sessionId);
	return toolNameParts(toolName.toLowerCase()).some((part) => promoted.has(part));
}

/**
 * Make a Deferred tool Direct for the rest of the session. Returns false when it is blocked and stays blocked.
 *
 * Scope is the session, not the turn: a model routinely searches on one turn and calls several turns later, which is
 * why codex keeps `ToolSearchOutput` items until a compaction drops them (core/src/compact_remote.rs:378-382).
 */
export function promoteToolToDirect(toolName: string, sessionId?: string): boolean {
	const normalized = normalizeToolName(toolName);
	const policy = getToolPolicy(sessionId);
	if (!normalized || policy?.isHidden(normalized)) return false;
	const promoted = promotedTools(sessionId);
	promoted.delete(normalized);
	promoted.add(normalized);
	while (promoted.size > MAX_PROMOTED_TOOLS) {
		const oldest = promoted.values().next().value;
		if (oldest === undefined) break;
		promoted.delete(oldest);
	}
	policy?.refreshActiveTools();
	return true;
}

/** Drop every promotion. A switched or shut-down session must not inherit the previous one's Direct surface. */
export function clearPromotedTools(sessionId?: string): void {
	PROMOTED_BY_SESSION.delete(sessionKey(sessionId));
}

// Code-mode off leaves a Declared tool with no caller, so it is promoted to Direct here rather than in the config:
// an overlay keeps tool-policy/config.json byte-identical across a toggle. Deferred stays Deferred in both modes —
// promoting 224 registered tools into the provider array costs far more than the search that finds one of them.
function codeModeReach(toolName: string, reach: ToolReach, enabled: boolean, sessionId?: string): ToolReach {
	if (reach === ToolReach.Deferred && isPromotedTool(toolName, sessionId)) return ToolReach.Direct;
	if (enabled) return reach;
	if (isCellRunnerTool(toolName)) return ToolReach.Blocked;
	return reach === ToolReach.Declared ? ToolReach.Direct : reach;
}

// The ~318 `codex_apps_*` and `mcp__*` tools would swamp the prompt, so only extension-registered natives declare.
// `tool_search` is Declared in code-mode and overlays Direct when code-mode is off, so it stays discoverable without
// adding a second cell runner to the provider array.
export function defaultToolReach(toolName: string, codeModeEnabled = isCodeModeEnabled()): ToolReach {
	const name = toolName.toLowerCase();
	if (name === "tool_search") return codeModeReach(name, ToolReach.Declared, codeModeEnabled);
	if (DEFAULT_DIRECT_TOOLS.includes(name)) return codeModeReach(name, ToolReach.Direct, codeModeEnabled);
	const connector = CONNECTOR_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
	return codeModeReach(name, connector ? ToolReach.Deferred : ToolReach.Declared, codeModeEnabled);
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeToolNames(values: unknown, fallback: readonly string[] = []): string[] {
	if (!Array.isArray(values)) return [...fallback];
	const normalized = values.map(normalizeToolName).filter((value): value is string => Boolean(value));
	return [...new Set(normalized)];
}

// A corrupt file falls back to the 3 replaced built-ins and the 11 default direct tools, never to an empty policy.
export function loadToolPolicyConfig(configPath: string): ToolPolicyConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<ToolPolicyConfig>;
		return {
			hiddenTools: normalizeToolNames(parsed.hiddenTools, Object.keys(REPLACED_BUILTIN_TOOLS)),
			directTools: normalizeToolNames(parsed.directTools, DEFAULT_DIRECT_TOOLS),
			declaredTools: normalizeToolNames(parsed.declaredTools),
			deferredTools: normalizeToolNames(parsed.deferredTools),
		};
	} catch {
		return {
			hiddenTools: Object.keys(REPLACED_BUILTIN_TOOLS),
			directTools: [...DEFAULT_DIRECT_TOOLS],
			declaredTools: [],
			deferredTools: [],
		};
	}
}

function saveToolPolicyConfig(configPath: string, config: ToolPolicyConfig): void {
	const tmpPath = `${configPath}.tmp`;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmpPath, configPath);
}

// codex exposes some tools as `functions.find`, while a human toggle and agent frontmatter both use the bare name.
function toolNameParts(toolName: string): string[] {
	const baseName = toolName.split(".").at(-1);
	return baseName && baseName !== toolName ? [toolName, baseName] : [toolName];
}

function matchesToolName(candidate: string, target: string): boolean {
	const candidateParts = toolNameParts(candidate.toLowerCase());
	const targetParts = toolNameParts(target.toLowerCase());
	return candidateParts.some((part) => targetParts.includes(part));
}

// Three shapes appear: a `name:` definition bullet, a "Use `x`" guideline, and a "Call `x`" guideline.
function bulletToolName(line: string): string | undefined {
	const trimmed = line.trim();
	const content = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
	const toolLine = content.match(/^([\w.-]+):/);
	if (toolLine?.[1]) return normalizeToolName(toolLine[1]);

	const useLine = content.match(/^Use `?([\w.-]+)`?\b/);
	if (useLine?.[1]) return normalizeToolName(useLine[1]);

	const callLine = content.match(/^Call `?([\w.-]+)`?\b/);
	if (callLine?.[1]) return normalizeToolName(callLine[1]);

	return undefined;
}

export function filterHiddenToolPromptLines(prompt: string, isHidden: (toolName: string) => boolean): string {
	return prompt
		.split("\n")
		.filter((line) => {
			const toolName = bulletToolName(line);
			return !toolName || !isHidden(toolName);
		})
		.join("\n");
}

export function removeHiddenToolsFromPromptOptions(
	options: PromptOptions | undefined,
	isHidden: (toolName: string) => boolean,
): void {
	if (!options) return;

	if (Array.isArray(options.selectedTools)) {
		options.selectedTools = options.selectedTools.filter((toolName) => !isHidden(toolName));
	}

	if (options.toolSnippets) {
		for (const toolName of Object.keys(options.toolSnippets)) {
			if (isHidden(toolName)) delete options.toolSnippets[toolName];
		}
	}

	if (Array.isArray(options.promptGuidelines)) {
		options.promptGuidelines = options.promptGuidelines.filter((line) => {
			const toolName = bulletToolName(line);
			return !toolName || !isHidden(toolName);
		});
	}
}

/** Why a hidden tool was refused, naming the replacement when there is one. */
export function hiddenToolReason(toolName: string): string {
	const replacement = REPLACED_BUILTIN_TOOLS[toolName] ?? REPLACED_BUILTIN_TOOLS[toolNameParts(toolName).at(-1) ?? ""];
	if (replacement) return `\`${toolName}\` is not available — ${replacement} instead.`;
	if (!isCodeModeEnabled() && isCellRunnerTool(toolName)) {
		return `\`${toolName}\` is off because code-mode is off. Every tool is direct; call it by name.`;
	}
	return `\`${toolName}\` is hidden by tool policy. Turn it back on from /token-burden if it is genuinely needed.`;
}

export type ToolPolicy = ReturnType<typeof createToolPolicy>;

export function createToolPolicy(
	pi: ToolApi,
	config: ToolPolicyConfig,
	configPath?: string,
	codeModeEnabled: () => boolean = isCodeModeEnabled,
	sessionId?: string,
) {
	let boundSessionId = sessionId;
	const sets: Record<AssignableReach, Set<string>> = {
		[ToolReach.Blocked]: new Set(normalizeToolNames(config.hiddenTools, Object.keys(REPLACED_BUILTIN_TOOLS))),
		[ToolReach.Direct]: new Set(normalizeToolNames(config.directTools, DEFAULT_DIRECT_TOOLS)),
		[ToolReach.Declared]: new Set(normalizeToolNames(config.declaredTools)),
		[ToolReach.Deferred]: new Set(normalizeToolNames(config.deferredTools)),
	};

	const assigned = (reach: AssignableReach, toolName: string) =>
		toolNameParts(toolName.toLowerCase()).some((part) => sets[reach].has(part));

	const isHidden = (toolName: string) =>
		assigned(ToolReach.Blocked, toolName) || (!codeModeEnabled() && isCellRunnerTool(toolName));

	const storedToolReach = (toolName: string, ignoreBlocked = false): ToolReach => {
		if (!ignoreBlocked && isHidden(toolName)) return ToolReach.Blocked;
		if (assigned(ToolReach.Direct, toolName)) return ToolReach.Direct;
		if (assigned(ToolReach.Declared, toolName)) return ToolReach.Declared;
		if (assigned(ToolReach.Deferred, toolName)) return ToolReach.Deferred;
		return defaultToolReach(toolName, codeModeEnabled());
	};

	const toolReach = (toolName: string, ignoreBlocked = false): ToolReach =>
		codeModeReach(toolName, storedToolReach(toolName, ignoreBlocked), codeModeEnabled(), boundSessionId);

	const persist = () => {
		if (!configPath) return;
		saveToolPolicyConfig(configPath, {
			hiddenTools: [...sets[ToolReach.Blocked]],
			directTools: [...sets[ToolReach.Direct]],
			declaredTools: [...sets[ToolReach.Declared]],
			deferredTools: [...sets[ToolReach.Deferred]],
		});
	};

	const applyPolicy = () => {
		const active = pi.getActiveTools();
		const next = active.filter((toolName) => toolReach(toolName) === ToolReach.Direct);
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	// `applyPolicy` only ever removes, so a code-mode toggle that promotes Declared tools has to name them.
	// `getAllTools()` is the only list of every tool pi knows; it carries no `execute` (tool-registry.ts:95), which
	// does not matter here because only the names are read.
	const refreshActiveTools = () => {
		const active = pi.getActiveTools();
		const known = pi.getAllTools?.().map((tool) => tool.name) ?? active;
		const next = [...new Set([...active, ...known])].filter((toolName) => toolReach(toolName) === ToolReach.Direct);
		if (!arraysEqual(active, next)) pi.setActiveTools(next);
	};

	const setToolReach = (toolName: string, reach: ToolReach): ToolToggleResult => {
		const normalized = normalizeToolName(toolName);
		const refused = { applied: false, activeToolNames: pi.getActiveTools() };
		if (!normalized || reach === ToolReach.Unreachable) return refused;
		if (PINNED_DIRECT_TOOLS.has(normalized) && reach !== ToolReach.Direct) return refused;

		if (reach === ToolReach.Blocked) {
			sets[ToolReach.Blocked].add(normalized);
		} else {
			for (const part of toolNameParts(normalized)) {
				for (const set of Object.values(sets)) set.delete(part);
			}
			sets[reach as AssignableReach].add(normalized);
		}

		const active = pi.getActiveTools();
		if (reach === ToolReach.Direct && !active.some((activeName) => matchesToolName(activeName, normalized))) {
			pi.setActiveTools([...active, normalized]);
		}
		applyPolicy();
		persist();
		return { applied: true, activeToolNames: pi.getActiveTools() };
	};

	// `before_agent_start` is the last point before the prompt reaches the provider, so it also corrects the prompt.
	const install = () => {
		pi.on("session_start", (_event, ctx) => {
			boundSessionId = sessionIdFromContext(ctx) ?? boundSessionId;
			applyPolicy();
		});
		pi.on("resources_discover", applyPolicy);
		// Clear only the session named by lifecycle context; child shutdown must not clear a sibling's promotions.
		pi.on("session_shutdown", (_event, ctx) => {
			const shutdownSessionId = sessionIdFromContext(ctx) ?? boundSessionId;
			clearPromotedTools(shutdownSessionId);
			if (shutdownSessionId === boundSessionId) boundSessionId = undefined;
		});
		pi.on("session_tree", (_event, ctx) => {
			clearPromotedTools(sessionIdFromContext(ctx) ?? boundSessionId);
			applyPolicy();
		});
		pi.on("model_select", applyPolicy);
		pi.on("before_agent_start", (event) => {
			applyPolicy();
			removeHiddenToolsFromPromptOptions(event.systemPromptOptions, isHidden);
			if (typeof event.systemPrompt !== "string") return;
			const systemPrompt = filterHiddenToolPromptLines(event.systemPrompt, isHidden);
			if (systemPrompt !== event.systemPrompt) return { systemPrompt };
		});
		pi.on("tool_call", (event) => {
			const toolName = normalizeToolName(event.toolName);
			if (!toolName || !isHidden(toolName)) return;
			return { block: true, reason: hiddenToolReason(toolName) };
		});
	};

	return {
		install,
		isHidden,
		toolReach,
		setToolReach,
		refreshActiveTools,
		getActiveToolNames: () => pi.getActiveTools(),
	};
}

// Jiti evaluates this file per extension. One session-keyed map shares policy state without mixing child sessions.
const LIVE_TOOL_POLICIES = Symbol.for("agents.toolPolicies");
const policyState = globalThis as typeof globalThis & Record<symbol, Map<string, ToolPolicy> | undefined>;
const policies = policyState[LIVE_TOOL_POLICIES] ?? new Map<string, ToolPolicy>();
policyState[LIVE_TOOL_POLICIES] = policies;

export function publishToolPolicy(policy: ToolPolicy, sessionId?: string): void {
	policies.set(sessionKey(sessionId), policy);
}

export function unpublishToolPolicy(sessionId?: string): void {
	policies.delete(sessionKey(sessionId));
}

export function getToolPolicy(sessionId?: string): ToolPolicy | undefined {
	return policies.get(sessionKey(sessionId));
}

// A subagent's `disallowed_tools` is also keyed by session id. Pi's own `tool_call` gate never sees nested calls,
// so nested dispatch checks the same session key before executing a registered tool.
// pi's own `tool_call` gate never sees a nested call — registry `execute` skips it (nested-dispatch.ts:1) — so a
// denied tool stayed callable as `tools.<name>()` from inside a cell.
const SESSION_DENIED_TOOLS = Symbol.for("agents.sessionDeniedTools");
const deniedState = globalThis as typeof globalThis & Record<symbol, Map<string, Set<string>> | undefined>;
const DENIED_BY_SESSION = deniedState[SESSION_DENIED_TOOLS] ?? new Map<string, Set<string>>();
deniedState[SESSION_DENIED_TOOLS] = DENIED_BY_SESSION;

/** Record a session's denied tools. An empty or absent list clears it, so a parent stays unrestricted. */
export function setSessionDeniedTools(sessionId: string, denied: Iterable<string> | undefined): void {
	const names = denied ? normalizeToolNames([...denied]) : [];
	if (names.length === 0) {
		DENIED_BY_SESSION.delete(sessionId);
		return;
	}
	DENIED_BY_SESSION.set(sessionId, new Set(names));
}

export function clearSessionDeniedTools(sessionId: string): void {
	DENIED_BY_SESSION.delete(sessionId);
}

/** Whether `toolName` is denied for `sessionId`. False for any session that never recorded a denial. */

export function isSessionDeniedTool(sessionId: string | undefined, toolName: string): boolean {
	const parts = toolNameParts(toolName.toLowerCase());
	if (!sessionId) return false;
	const denied = DENIED_BY_SESSION.get(sessionId);
	if (!denied) return false;
	return parts.some((part) => denied.has(part));
}

/** Why a denied tool was refused. Names the restriction, so the model stops instead of seeking a shell around it. */
export function deniedToolReason(toolName: string): string {
	return `\`${toolName}\` is denied for this agent and stays denied inside a cell. Do not look for another way to run it.`;
}
