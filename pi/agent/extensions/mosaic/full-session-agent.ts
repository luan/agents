import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_TOOL_NAMES,
	getAllowedToolNamesForType,
	getConfig,
	getMemoryToolNames,
	getReadOnlyMemoryToolNames,
} from "./agent-types.js";
import { buildParentContext } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { mergeModelPresets, resolveModelPreset } from "./model-presets.js";
import { type ModelRegistry, resolveDefaultModel } from "./model-resolver.js";
import { launchMosaicTarget, type MultiplexerTarget } from "./multiplexer.js";
import { mosaicCommandForSession, resolveOwner } from "./mux.js";
import { listActive } from "./mux-heartbeat.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { loadSettings } from "./settings.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { createWorktree } from "./worktree.js";

export interface FullSessionLaunchOptions {
	id?: string;
	type: SubagentType;
	description: string;
	prompt: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	isolation?: IsolationMode;
	cwd?: string;
	agentConfig?: AgentConfig;
	messageEndpoint?: string;
	messageToken?: string;
}

export interface FullSessionLaunchResult {
	id: string;
	laneId: string;
	sessionFile: string;
	paneId: string;
	windowId: string;
	tmuxSession: string;
	windowName: string;
	cwd: string;
	worktree?: { path: string; branch: string };
	placement?: MultiplexerTarget["placement"];
	mosaicIdentity: MosaicAgentIdentity;
}

const BOOTSTRAP_DIR = join(tmpdir(), "mosaic-bootstrap");
const MOSAIC_AGENT_COLORS = ["f38ba8", "fab387", "f9e2af", "eba0ac", "e78284", "ff9e64", "ffc777", "ff757f"];
let lastMosaicAgentIndex = 0;

export interface MosaicAgentIdentity {
	label: string;
	name: string;
	color: string;
}

export async function launchFullSessionAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: FullSessionLaunchOptions,
): Promise<FullSessionLaunchResult> {
	const id = options.id ?? randomUUID().slice(0, 17);
	let effectiveCwd = options.cwd ?? ctx.cwd;
	let worktree: { path: string; branch: string } | undefined;
	if (options.isolation === "worktree") {
		const created = createWorktree(effectiveCwd, id);
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

	const parentActiveToolNames = new Set(pi.getActiveTools());
	const explicitAllowedToolNames = getAllowedToolNamesForType(options.type);
	const selectedToolNames = new Set(explicitAllowedToolNames ?? [...parentActiveToolNames]);
	let toolNames = BUILTIN_TOOL_NAMES.filter((name) => selectedToolNames.has(name));
	if (agentConfig.memory) {
		const existingNames = new Set(toolNames);
		const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
		const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
		const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");
		if (hasWriteTools) {
			const extraNames = getMemoryToolNames(existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
				for (const name of extraNames) selectedToolNames.add(name);
			}
			extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		} else {
			const extraNames = getReadOnlyMemoryToolNames(existingNames);
			if (extraNames.length > 0) {
				toolNames = [...toolNames, ...extraNames];
				for (const name of extraNames) selectedToolNames.add(name);
			}
			extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
		}
	}

	const env = await detectEnv(pi, effectiveCwd);
	let systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, ctx.getSystemPrompt(), extras);
	if (options.messageEndpoint) systemPrompt = withMosaicLeaderInstructions(systemPrompt);
	const prompt = options.inheritContext ? buildParentContext(ctx) + options.prompt : options.prompt;
	const preset = resolveModelPreset(
		agentConfig.modelPreset,
		ctx.modelRegistry as ModelRegistry,
		mergeModelPresets(loadSettings(effectiveCwd).modelPresets),
	);
	const launchModel =
		options.model ??
		resolveDefaultModel(preset.model ?? ctx.model, ctx.modelRegistry as ModelRegistry, agentConfig.model);
	const launchThinkingLevel = options.thinkingLevel ?? agentConfig.thinking ?? preset.thinking;

	const sm = SessionManager.create(effectiveCwd, ctx.sessionManager.getSessionDir());
	sm.newSession({ parentSession: ctx.sessionManager.getSessionFile() });
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Failed to create mosaic agent session.");

	const selfPane = process.env.TMUX_PANE;
	const ownerPane = selfPane ?? process.env.ZELLIJ_PANE_ID ?? "mosaic";
	const owner = resolveOwner(ownerPane);
	const windowName = buildWindowName(options.description);
	const mosaicIdentity = assignMosaicAgentIdentity(owner, options.description, options.type);
	const bootstrapFile = writeBootstrapFile(
		buildBootstrapPayload({
			agentId: id,
			agentType: options.type,
			description: options.description,
			prompt,
			systemPrompt,
			builtinToolNames: toolNames,
			parentActiveToolNames: [...parentActiveToolNames],
			allowedToolNames: explicitAllowedToolNames,
			extensions,
			disallowedTools: agentConfig.disallowedTools,
			mosaicIdentity,
			messageEndpoint: options.messageEndpoint,
			messageToken: options.messageToken,
		}),
	);

	const spawned = await launchMosaicTarget({
		command: buildCommand(sessionFile, launchModel, launchThinkingLevel),
		cwd: effectiveCwd,
		owner,
		name: windowName,
		agentId: id,
		waitForReady: !options.messageEndpoint,
		extraEnv: {
			MOSAIC_BOOTSTRAP_FILE: bootstrapFile,
			MOSAIC_AGENT_LABEL: mosaicIdentity.label,
			MOSAIC_AGENT_NAME: mosaicIdentity.name,
			MOSAIC_AGENT_COLOR: mosaicIdentity.color,
		},
	});

	return {
		id,
		laneId: id,
		sessionFile,
		paneId: spawned.paneId,
		windowId: spawned.windowId ?? "",
		tmuxSession: spawned.tmuxSession ?? spawned.zellijSession ?? "",
		windowName,
		cwd: effectiveCwd,
		worktree,
		placement: spawned.placement,
		mosaicIdentity,
	};
}

export interface FullSessionBootstrapPayload {
	agentId: string;
	agentType: SubagentType;
	description: string;
	prompt: string;
	systemPrompt: string;
	builtinToolNames: string[];
	parentActiveToolNames?: string[];
	allowedToolNames?: string[];
	extensions: true | string[] | false;
	disallowedTools?: string[];
	mosaicIdentity?: MosaicAgentIdentity;
	messageEndpoint?: string;
	messageToken?: string;
}

export function buildBootstrapPayload(payload: FullSessionBootstrapPayload): FullSessionBootstrapPayload {
	return payload;
}

export function withMosaicLeaderInstructions(systemPrompt: string): string {
	return `${systemPrompt}

<mosaic_leader_channel>
You are a mosaic agent working for a leader session.
- Use the message_leader tool to send questions, status updates, or cleanup requests to your leader.
- If the user asks you to ask/tell/contact the leader, call message_leader.
- Do not use spawn_lane, spawn_list, or spawn_map to find the leader; those tools are unrelated to the mosaic leader channel.
- Your normal assistant reply is also reported to the leader automatically when your turn completes.
</mosaic_leader_channel>`;
}

function writeBootstrapFile(payload: unknown): string {
	mkdirSync(BOOTSTRAP_DIR, { recursive: true, mode: 0o700 });
	chmodSync(BOOTSTRAP_DIR, 0o700);
	const path = join(BOOTSTRAP_DIR, `${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
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

function cleanIdentityPart(value: string | undefined): string | undefined {
	const text = value
		?.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function nextMosaicAgentIndex(owner: string): number {
	const activeMax = Math.max(
		0,
		...listActive()
			.filter((entry) => entry.owner === owner)
			.map((entry) => {
				const match = entry.mosaicAgentLabel?.match(/^A(\d+)$/);
				return match ? Number(match[1]) : 0;
			}),
	);
	lastMosaicAgentIndex = Math.max(lastMosaicAgentIndex, activeMax);
	lastMosaicAgentIndex++;
	return lastMosaicAgentIndex;
}

function assignMosaicAgentIdentity(owner: string, description: string, type: SubagentType): MosaicAgentIdentity {
	const index = nextMosaicAgentIndex(owner);
	const name = cleanIdentityPart(description) ?? cleanIdentityPart(type) ?? "agent";
	return {
		label: `A${index}`,
		name,
		color: MOSAIC_AGENT_COLORS[(index - 1) % MOSAIC_AGENT_COLORS.length]!,
	};
}
