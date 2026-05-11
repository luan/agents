import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { buildParentContext } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { launchMosaicTarget } from "./multiplexer.js";
import { mosaicCommandForSession, resolveOwner } from "./mux.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { createWorktree } from "./worktree.js";

export interface FullSessionLaunchOptions {
	type: SubagentType;
	description: string;
	prompt: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	isolation?: IsolationMode;
	agentConfig?: AgentConfig;
}

export interface FullSessionLaunchResult {
	id: string;
	sessionFile: string;
	paneId: string;
	windowId: string;
	tmuxSession: string;
	windowName: string;
	cwd: string;
	worktree?: { path: string; branch: string };
}

const BOOTSTRAP_DIR = join(tmpdir(), "mosaic-bootstrap");

export async function launchFullSessionAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: FullSessionLaunchOptions,
): Promise<FullSessionLaunchResult> {
	const id = randomUUID().slice(0, 17);
	let effectiveCwd = ctx.cwd;
	let worktree: { path: string; branch: string } | undefined;
	if (options.isolation === "worktree") {
		const created = createWorktree(ctx.cwd, id);
		if (!created) {
			throw new Error(
				'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
					"Initialize git and commit at least once, or omit `isolation`.",
			);
		}
		worktree = created;
		effectiveCwd = created.path;
	}

	const agentConfig = options.agentConfig ?? DEFAULT_AGENTS.get("general-purpose");
	if (!agentConfig) throw new Error("No general-purpose agent config is available.");

	const config = getConfig(options.type);
	const extensions = options.isolated ? false : config.extensions;
	const skills = options.isolated ? false : config.skills;

	const extras: PromptExtras = {};
	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, effectiveCwd);
		if (loaded.length > 0) extras.skillBlocks = loaded;
	}

	let toolNames = getToolNamesForType(options.type);
	if (agentConfig.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
		const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
		const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");
		if (hasWriteTools) {
			const extraNames = getMemoryToolNames(existingNames);
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
			extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		} else {
			const extraNames = getReadOnlyMemoryToolNames(existingNames);
			if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
			extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		}
	}

	const env = await detectEnv(pi, effectiveCwd);
	const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, ctx.getSystemPrompt(), extras);
	const prompt = options.inheritContext ? buildParentContext(ctx) + options.prompt : options.prompt;

	const sm = SessionManager.create(effectiveCwd, ctx.sessionManager.getSessionDir());
	sm.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Failed to create mosaic agent session.");

	const bootstrapFile = writeBootstrapFile({
		agentId: id,
		agentType: options.type,
		description: options.description,
		prompt,
		systemPrompt,
		builtinToolNames: toolNames,
		extensions,
		disallowedTools: agentConfig.disallowedTools,
	});

	const selfPane = process.env.TMUX_PANE;
	const ownerPane = selfPane ?? process.env.ZELLIJ_PANE_ID ?? "mosaic";
	const windowName = buildWindowName(options.description);
	const spawned = launchMosaicTarget({
		command: buildCommand(sessionFile, options.model, options.thinkingLevel),
		cwd: effectiveCwd,
		owner: resolveOwner(ownerPane),
		name: windowName,
		agentId: id,
		extraEnv: { MOSAIC_BOOTSTRAP_FILE: bootstrapFile },
	});

	return {
		id,
		sessionFile,
		paneId: spawned.paneId,
		windowId: spawned.windowId ?? "",
		tmuxSession: spawned.tmuxSession ?? spawned.zellijSession ?? "",
		windowName,
		cwd: effectiveCwd,
		worktree,
	};
}

function writeBootstrapFile(payload: unknown): string {
	mkdirSync(BOOTSTRAP_DIR, { recursive: true });
	const path = join(BOOTSTRAP_DIR, `${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(payload), "utf8");
	return path;
}

function buildCommand(sessionFile: string, model: Model<any> | undefined, thinking: ThinkingLevel | undefined): string {
	const parts = [mosaicCommandForSession(sessionFile)];
	if (model) parts.push("--model", shellQuote(`${model.provider}/${model.id}`));
	if (thinking) parts.push("--thinking", shellQuote(thinking));
	return parts.join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWindowName(description: string): string {
	const label =
		description
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.replace(/\s+/g, " ")
			.trim() || "agent";
	return `mc: ${label}`.slice(0, 80);
}
