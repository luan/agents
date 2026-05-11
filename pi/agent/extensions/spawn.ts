import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	CURRENT_SESSION_VERSION,
	convertToLlm,
	estimateTokens,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { navInput, navOptionalInput, navSelect } from "./cockpit-nav.ts";

const CONTEXT_RECENT_TOKEN_BUDGET = 8_000;
const SPAWN_ENTRY_TYPE = "spawn-lane";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a spawned session, generate a focused prompt that is self-contained and actionable.

Optimize for a clean child session, not a transcript summary. If the goal is related to the parent session but in a different context, include only a brief orientation and the specific facts needed for that child lane. Prefer concise references to files, commands, artifacts, decisions, and constraints over broad conversation history.

Include only context needed for the next slice:
- current objective, if it affects the child task
- relevant decisions and constraints
- files, commands, or artifacts that matter
- current repo/session state if present and relevant
- exact next task and verification expectations
- session guidance only when it is concrete: whether this is a parallel lane, a continuation, or a narrow next slice

Do not add or infer a category, mode, lens, or prefix line. Do not include generic encouragement, fake placeholders, broad history, or a preamble. Output only the prompt.`;

type SpawnPayload = "empty" | "direct" | "context";
type SpawnRelation = "root" | "child";
type SpawnPlacement = "new-session" | "new-window" | "split-pane";
type SpawnSplitDirection = "horizontal" | "vertical";
type SpawnRuntime = "pi" | "shell" | "command";
type SpawnMux = "auto" | "tmux" | "none";
type ResolvedSpawnRuntime = "pi" | "shell" | "command";
type ResolvedSpawnMux = "tmux" | "none";

type PiSessionRef = {
	sessionPath: string;
	parentSessionPath?: string;
	cwd: string;
	name: string;
};

type MuxPlacementRef = {
	mux: ResolvedSpawnMux;
	tmux?: {
		session: string;
		windowId?: string;
		windowName?: string;
		paneId?: string;
		placement: "new-window" | "split-pane";
		splitDirection?: SpawnSplitDirection;
		splitSizePercent?: number;
	};
};

type SpawnLaneRef = {
	runtime: ResolvedSpawnRuntime;
	sessionPath?: string;
	parentSessionPath?: string;
	cwd: string;
	name: string;
	command?: string;
};

type SpawnRequest = {
	runtime: SpawnRuntime;
	payload: SpawnPayload;
	relation: SpawnRelation;
	placement: SpawnPlacement;
	mux: SpawnMux;
	cwd: string;
	splitDirection?: SpawnSplitDirection;
	splitSizePercent?: number;
	targetSessionPath?: string;
	targetMuxSession?: string;
	command?: string;
	prompt: string;
	goal: string;
	name: string;
	reviewPrompt: boolean;
	waitForIdle: boolean;
};

type SpawnResult = {
	id: string;
	runtime: ResolvedSpawnRuntime;
	relation: SpawnRelation;
	payload: SpawnPayload;
	placement: SpawnPlacement;
	splitDirection?: SpawnSplitDirection;
	splitSizePercent?: number;
	targetSessionPath?: string;
	targetMuxSession?: string;
	mux: ResolvedSpawnMux;
	parent?: PiSessionRef;
	child: SpawnLaneRef;
	command?: string;
	promptPath: string;
	goal: string;
	createdAt: number;
	implementation: {
		runtime: SpawnLaneRef;
		mux: MuxPlacementRef;
	};
};

type SpawnLaneEntry = SpawnResult;

type SpawnCapabilities = {
	runtimes: Record<ResolvedSpawnRuntime, boolean>;
	muxes: Record<ResolvedSpawnMux, boolean>;
	placements: Record<SpawnPlacement, boolean>;
};

type SpawnCommandContext = ExtensionContext & {
	waitForIdle?: () => Promise<void>;
	newSession?: (options?: any) => Promise<{ cancelled?: boolean }>;
};

type NormalizedToolParams = {
	payload?: string;
	relation?: string;
	placement?: string;
	splitDirection?: string;
	splitSizePercent?: number | string;
	targetSessionPath?: string;
	targetMuxSession?: string;
	runtime?: string;
	mux?: string;
	command?: string;
	prompt?: string;
	goal?: string;
	cwd?: string;
	name?: string;
};

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type !== "compaction") return undefined;
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function budgetRecentMessages(messages: AgentMessage[]): AgentMessage[] {
	const selected: AgentMessage[] = [];
	let tokens = 0;
	let startIndex = messages.length;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const nextTokens = tokens + estimateTokens(message);
		if (selected.length > 0 && nextTokens > CONTEXT_RECENT_TOKEN_BUDGET) break;
		selected.unshift(message);
		startIndex = i;
		tokens = nextTokens;
	}

	while (selected[0]?.role === "toolResult") {
		selected.shift();
		startIndex++;
	}

	while (selected.length === 0 && startIndex > 0) {
		const previous = messages[--startIndex];
		if (previous.role !== "toolResult") selected.unshift(previous);
	}

	return selected;
}

function contextTransferMessages(branch: SessionEntry[]): AgentMessage[] {
	const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
	const compaction = compactionIndex >= 0 ? entryToMessage(branch[compactionIndex]) : undefined;
	const firstKeptIndex =
		compactionIndex >= 0 && branch[compactionIndex].type === "compaction"
			? branch.findIndex((entry) => entry.id === branch[compactionIndex].firstKeptEntryId)
			: -1;
	const recentEntries =
		compactionIndex >= 0
			? [
					...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
					...branch.slice(compactionIndex + 1),
				]
			: branch;
	const recentMessages = budgetRecentMessages(
		recentEntries.map(entryToMessage).filter((message) => message !== undefined),
	);

	return compaction ? [compaction, ...recentMessages] : recentMessages;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function generateContextTransferText(
	goal: string,
	conversationText: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	if (!ctx.model) throw new Error("No model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);

	const userMessage: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `## Conversation History\n\n${conversationText}\n\n## Goal For New Session\n\n${goal}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") throw new Error("Context generation aborted");
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function generateContextTransferDraft(
	goal: string,
	conversationText: string,
	ctx: ExtensionContext,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating context prompt...");
		loader.onAbort = () => done(null);

		generateContextTransferText(goal, conversationText, ctx, loader.signal)
			.then(done)
			.catch((error) => {
				console.error("Context generation failed:", error);
				done(null);
			});

		return loader;
	});
}

function tokenizeArgs(args: string): string[] {
	return [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function splitCommandTail(args: string): { head: string; commandTail: string } {
	const match = args.match(/(?:^|\s)--\s/);
	if (!match || match.index === undefined) return { head: args, commandTail: "" };
	return {
		head: args.slice(0, match.index).trim(),
		commandTail: args.slice(match.index + match[0].length).trim(),
	};
}

function parsePayload(value: string | undefined): SpawnPayload | undefined {
	if (value === "empty" || value === "direct" || value === "context") return value;
	return undefined;
}

function parseRelation(value: string | undefined): SpawnRelation | undefined {
	if (value === "root" || value === "new") return "root";
	if (value === "child") return "child";
	return undefined;
}

function parsePlacement(value: string | undefined): SpawnPlacement | undefined {
	if (value === "new-session" || value === "same" || value === "same-tab" || value === "session") return "new-session";
	if (value === "new-window" || value === "window" || value === "tmux") return "new-window";
	if (value === "split-pane" || value === "split" || value === "pane") return "split-pane";
	return undefined;
}

function parseSplitDirection(value: string | undefined): SpawnSplitDirection | undefined {
	if (value === "horizontal" || value === "h") return "horizontal";
	if (value === "vertical" || value === "v") return "vertical";
	return undefined;
}

function parseSplitSizePercent(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value).replace(/%$/, ""), 10);
	if (!Number.isFinite(parsed)) return undefined;
	return parsed;
}

function validateSplitSizePercent(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 10 || value > 90)
		throw new Error("splitSizePercent must be an integer from 10 to 90");
	return value;
}

function parseRuntime(value: string | undefined): SpawnRuntime | undefined {
	if (value === "pi" || value === "agent") return "pi";
	if (value === "shell" || value === "bash" || value === "sh" || value === "zsh") return "shell";
	if (value === "command" || value === "cmd" || value === "run") return "command";
	return undefined;
}

function parseRuntimeOrThrow(value: string | undefined, label: string): SpawnRuntime {
	const parsed = parseRuntime(value);
	if (!parsed) throw new Error(`Unsupported ${label}: ${value || "(missing)"}`);
	return parsed;
}

function parseMux(value: string | undefined): SpawnMux | undefined {
	if (value === "auto" || value === "tmux" || value === "none") return value;
	return undefined;
}

function inferWindowName(goal: string): string {
	const words = normalize(goal)
		.replace(/[^a-z0-9_-]+/g, " ")
		.split(" ")
		.filter(
			(word) =>
				word && !["the", "a", "an", "to", "for", "and", "or", "with", "this", "that", "continue"].includes(word),
		);
	return sanitizeWindowName(words.slice(0, 4).join("-")) || "spawn";
}

function sanitizeWindowName(text: string): string {
	return normalize(text)
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36);
}

function normalizeSpawnRequest(input: Partial<SpawnRequest>, ctx: ExtensionContext): SpawnRequest {
	const runtime =
		input.runtime ??
		(input.command ? "command" : input.payload === "direct" || input.payload === "context" ? "pi" : "shell");
	const payload = input.payload ?? (runtime === "shell" || runtime === "command" ? "empty" : "direct");
	const currentCwd = resolve(ctx.cwd);
	const cwd = input.cwd ? resolve(ctx.cwd, input.cwd) : currentCwd;
	const targetSessionPath = input.targetSessionPath ? resolve(ctx.cwd, input.targetSessionPath) : undefined;
	let relation = input.relation ?? (runtime === "shell" || runtime === "command" ? "root" : "child");
	if (runtime === "shell" || runtime === "command") relation = "root";
	if (relation === "child" && cwd !== currentCwd && !targetSessionPath) relation = "root";
	const placement = input.placement ?? "new-window";
	const mux = input.mux ?? "auto";
	const splitSizePercent = validateSplitSizePercent(input.splitSizePercent);
	const targetMuxSession = input.targetMuxSession?.trim() || undefined;
	const command = input.command?.trim() || undefined;
	const prompt = input.prompt ?? "";
	const goal = input.goal || prompt || command || `${runtime} spawn`;
	const name = sanitizeWindowName(input.name || inferWindowName(goal || payload));

	return {
		runtime,
		payload,
		relation,
		placement,
		mux,
		cwd,
		splitDirection: input.splitDirection,
		splitSizePercent,
		targetSessionPath,
		targetMuxSession,
		command,
		prompt,
		goal,
		name,
		reviewPrompt: input.reviewPrompt ?? false,
		waitForIdle: input.waitForIdle ?? false,
	};
}

function parseSpawnRequest(args: string, ctx: ExtensionContext): SpawnRequest | undefined {
	const { head, commandTail } = splitCommandTail(args);
	const tokens = tokenizeArgs(head);
	if (tokens.length === 0) return undefined;

	let runtime: SpawnRuntime | undefined;
	let payload: SpawnPayload | undefined;
	let relation: SpawnRelation | undefined;
	let placement: SpawnPlacement | undefined;
	let splitDirection: SpawnSplitDirection | undefined;
	let splitSizePercent: number | undefined;
	let targetSessionPath: string | undefined;
	let targetMuxSession: string | undefined;
	let mux: SpawnMux | undefined;
	let command: string | undefined;
	let cwd = ctx.cwd;
	let name = "";
	const promptParts: string[] = [];

	let index = 0;
	const firstRuntime = parseRuntime(tokens[index]?.toLowerCase());
	const firstPayload = parsePayload(tokens[index]?.toLowerCase());
	if (firstRuntime && !firstPayload) {
		runtime = firstRuntime;
		if (runtime === "shell" || runtime === "command") payload = "empty";
		index++;
	}

	const payloadAfterRuntime = parsePayload(tokens[index]?.toLowerCase());
	if (payloadAfterRuntime) {
		payload = payloadAfterRuntime;
		if (!runtime) runtime = "pi";
		index++;
	}

	const firstPayloadOnly = !runtime ? parsePayload(tokens[index]?.toLowerCase()) : undefined;
	if (firstPayloadOnly) {
		payload = firstPayloadOnly;
		runtime = "pi";
		index++;
	}

	const firstRelation = parseRelation(tokens[index]?.toLowerCase());
	if (firstRelation) {
		relation = firstRelation;
		index++;
	}

	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--placement") {
			placement = parsePlacement(tokens[++index]?.toLowerCase()) ?? placement;
			continue;
		}
		if (token === "--split-direction" || token === "--splitDirection") {
			splitDirection = parseSplitDirection(tokens[++index]?.toLowerCase()) ?? splitDirection;
			continue;
		}
		if (
			token === "--split-size-percent" ||
			token === "--splitSizePercent" ||
			token === "--split-size" ||
			token === "--split-percent"
		) {
			splitSizePercent = parseSplitSizePercent(tokens[++index]);
			continue;
		}
		if (token === "--target-session-path" || token === "--targetSessionPath" || token === "--target-session") {
			const next = tokens[++index];
			if (next) targetSessionPath = resolve(ctx.cwd, next);
			continue;
		}
		if (token === "--target-mux-session" || token === "--targetMuxSession" || token === "--tmux-session") {
			targetMuxSession = tokens[++index] ?? targetMuxSession;
			continue;
		}
		if (token === "--runtime") {
			runtime = parseRuntimeOrThrow(tokens[++index]?.toLowerCase(), "runtime");
			if (runtime === "shell" || runtime === "command") payload = payload ?? "empty";
			continue;
		}
		if (token === "--mux") {
			mux = parseMux(tokens[++index]?.toLowerCase()) ?? mux;
			continue;
		}
		if (token === "--cwd") {
			const next = tokens[++index];
			if (next) cwd = resolve(ctx.cwd, next);
			continue;
		}
		if (token === "--name") {
			name = tokens[++index] ?? "";
			continue;
		}
		if (token === "--command" || token === "--cmd") {
			command = tokens[++index] ?? "";
			continue;
		}
		const placementFlag = token.startsWith("--") ? parsePlacement(token.slice(2).toLowerCase()) : undefined;
		if (placementFlag) {
			placement = placementFlag;
			continue;
		}
		const directionFlag = token.startsWith("--") ? parseSplitDirection(token.slice(2).toLowerCase()) : undefined;
		if (directionFlag) {
			splitDirection = directionFlag;
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unsupported spawn option: ${token}`);
		promptParts.push(token);
	}

	const prompt = promptParts.join(" ").trim();
	if (!command && runtime === "command") command = commandTail || prompt;
	return normalizeSpawnRequest(
		{
			runtime,
			payload,
			relation,
			placement,
			splitDirection,
			splitSizePercent,
			targetSessionPath,
			targetMuxSession,
			mux,
			cwd,
			name,
			command,
			prompt: command ? "" : prompt,
			goal: command || prompt,
			reviewPrompt: true,
			waitForIdle: true,
		},
		ctx,
	);
}

async function promptSpawnRequest(ctx: ExtensionContext): Promise<SpawnRequest | undefined> {
	let runtime: SpawnRuntime = "pi";
	let payload: SpawnPayload = "direct";
	let relation: SpawnRelation = "child";
	let placement: SpawnPlacement = "new-window";
	let splitDirection: SpawnSplitDirection | undefined;
	let splitSizePercent: number | undefined;
	let targetSessionPath: string | undefined;
	let targetMuxSession: string | undefined;
	let cwd = ctx.cwd;
	let prompt = "";
	let command = "";

	while (true) {
		runtime = "pi";
		payload = "direct";
		relation = "child";
		splitDirection = undefined;
		splitSizePercent = undefined;
		targetSessionPath = undefined;
		targetMuxSession = undefined;
		cwd = ctx.cwd;
		prompt = "";
		command = "";

		const runtimeResult = await navSelect(ctx, "Spawn runtime", ["pi agent", "shell", "command"]);
		if (runtimeResult.action !== "value") return undefined;
		runtime = runtimeResult.value === "pi agent" ? "pi" : (runtimeResult.value as SpawnRuntime);

		if (runtime === "pi") {
			const payloadResult = await navSelect(ctx, "Spawn payload", ["direct", "context", "empty"]);
			if (payloadResult.action === "back") continue;
			if (payloadResult.action === "cancel") return undefined;
			payload = payloadResult.value as SpawnPayload;
		} else {
			payload = "empty";
			relation = "root";
		}

		if (runtime === "pi") {
			const relationResult = await navSelect(ctx, "Spawn relation", ["child", "root"]);
			if (relationResult.action === "back") continue;
			if (relationResult.action === "cancel") return undefined;
			relation = relationResult.value as SpawnRelation;
		}

		const placementOptions =
			runtime === "pi" ? ["new window", "split pane", "new session"] : ["new window", "split pane"];
		const placementResult = await navSelect(ctx, "Placement", placementOptions);
		if (placementResult.action === "back") continue;
		if (placementResult.action === "cancel") return undefined;
		placement =
			placementResult.value === "new session"
				? "new-session"
				: placementResult.value === "split pane"
					? "split-pane"
					: "new-window";

		if (placement === "split-pane") {
			const directionResult = await navSelect(ctx, "Split direction", ["default", "horizontal", "vertical"]);
			if (directionResult.action === "back") continue;
			if (directionResult.action === "cancel") return undefined;
			splitDirection =
				directionResult.value === "default" ? undefined : (directionResult.value as SpawnSplitDirection);

			const sizeResult = await navSelect(ctx, "Split size", ["default", "30%", "50%", "enter percent"]);
			if (sizeResult.action === "back") continue;
			if (sizeResult.action === "cancel") return undefined;
			if (sizeResult.value === "enter percent") {
				const input = await navInput(ctx, "Split size percent (10-90)");
				if (input.action === "back") continue;
				if (input.action === "cancel") return undefined;
				splitSizePercent = parseSplitSizePercent(input.value);
			} else {
				splitSizePercent = parseSplitSizePercent(sizeResult.value);
			}
		}

		if (placement !== "new-session") {
			const muxTargetResult = await navSelect(ctx, "Mux target", [
				"current mux session",
				"enter target mux session",
			]);
			if (muxTargetResult.action === "back") continue;
			if (muxTargetResult.action === "cancel") return undefined;
			if (muxTargetResult.value === "enter target mux session") {
				const input = await navInput(ctx, "Target mux session");
				if (input.action === "back") continue;
				if (input.action === "cancel") return undefined;
				targetMuxSession = input.value;
			}
		}

		const cwdResult = await navSelect(ctx, "Working directory", ["current cwd", "enter target cwd"]);
		if (cwdResult.action === "back") continue;
		if (cwdResult.action === "cancel") return undefined;
		if (cwdResult.value === "enter target cwd") {
			const input = await navInput(ctx, "Target cwd");
			if (input.action === "back") continue;
			if (input.action === "cancel") return undefined;
			cwd = resolve(ctx.cwd, input.value);
		}

		if (runtime === "pi" && relation === "child") {
			const parentOptions =
				cwd === resolve(ctx.cwd)
					? ["current session", "enter target parent session path"]
					: ["root for target cwd", "enter target parent session path", "current session"];
			const parentResult = await navSelect(ctx, "Parent session", parentOptions);
			if (parentResult.action === "back") continue;
			if (parentResult.action === "cancel") return undefined;
			if (parentResult.value === "root for target cwd") relation = "root";
			if (parentResult.value === "enter target parent session path") {
				const input = await navInput(ctx, "Target parent session path");
				if (input.action === "back") continue;
				if (input.action === "cancel") return undefined;
				targetSessionPath = resolve(ctx.cwd, input.value);
			}
		}

		if (runtime === "command") {
			const input = await navInput(ctx, "Command to run");
			if (input.action === "back") continue;
			if (input.action === "cancel") return undefined;
			command = input.value;
		} else if (runtime === "shell") {
			const name = await navOptionalInput(ctx, "Lane name (optional)");
			if (name.action === "back") continue;
			if (name.action === "cancel") return undefined;
			prompt = name.value;
		} else if (payload === "empty") {
			const name = await navOptionalInput(ctx, "Lane name (optional)");
			if (name.action === "back") continue;
			if (name.action === "cancel") return undefined;
			prompt = name.value;
		} else {
			const input = await navInput(ctx, payload === "context" ? "Context-transfer goal" : "Initial prompt");
			if (input.action === "back") continue;
			if (input.action === "cancel") return undefined;
			prompt = input.value;
		}
		break;
	}

	return normalizeSpawnRequest(
		{
			runtime,
			payload,
			relation,
			placement,
			splitDirection,
			splitSizePercent,
			targetSessionPath,
			targetMuxSession,
			cwd,
			command,
			prompt,
			goal: command || prompt,
			reviewPrompt: true,
			waitForIdle: true,
		},
		ctx,
	);
}

function directSpawnPrompt(request: SpawnRequest): string {
	if (!request.prompt) return "";
	return [
		`Task: ${request.prompt}`,
		request.cwd ? `Target directory: ${request.cwd}` : undefined,
		request.relation === "child"
			? "This is a fresh linked child lane. Preserve the user's goal and constraints, but do not assume parent conversation context unless it is explicitly included here."
			: undefined,
	]
		.filter(Boolean)
		.join("\n\n");
}

async function buildSpawnPayload(
	request: SpawnRequest,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ prompt: string; promptGoal: string }> {
	if (request.payload === "empty") return { prompt: "", promptGoal: request.goal || request.name };

	if (request.payload === "direct") {
		const prompt = directSpawnPrompt(request);
		if (!request.reviewPrompt || !ctx.hasUI) return { prompt, promptGoal: request.goal || request.prompt };
		const edited = await ctx.ui.editor("Edit spawn prompt", prompt);
		if (edited === undefined) throw new Error("Spawn cancelled");
		return { prompt: edited, promptGoal: request.goal || request.prompt };
	}

	if (!request.goal && !request.prompt) throw new Error("Context spawn requires a goal or prompt");
	const goal = request.goal || request.prompt;
	if (!request.reviewPrompt && request.prompt) {
		return { prompt: request.prompt, promptGoal: goal };
	}

	if (!ctx.model) throw new Error("No model selected");
	const messages = contextTransferMessages(ctx.sessionManager.getBranch());
	if (messages.length === 0) throw new Error("No conversation to transfer into a spawn context");
	const conversationText = serializeConversation(convertToLlm(messages));
	const draft =
		request.reviewPrompt && ctx.hasUI
			? await generateContextTransferDraft(goal, conversationText, ctx)
			: await generateContextTransferText(goal, conversationText, ctx, signal);
	if (draft === null) throw new Error("Spawn cancelled");
	const edited = request.reviewPrompt && ctx.hasUI ? await ctx.ui.editor("Edit spawned context prompt", draft) : draft;
	if (edited === undefined) throw new Error("Spawn cancelled");
	return { prompt: edited, promptGoal: goal };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function piSpawnCommand(sessionPath: string, promptPath: string): string {
	return promptPath
		? `bash -lc ${shellQuote('pi --session "$1" "$(cat "$2")"')} pi-spawn ${shellQuote(sessionPath)} ${shellQuote(promptPath)}`
		: `bash -lc ${shellQuote('pi --session "$1"')} pi-spawn ${shellQuote(sessionPath)}`;
}

function shellSpawnCommand(): string {
	return `bash -lc ${shellQuote('exec "$' + '{SHELL:-bash}" -l')}`;
}

function commandSpawnCommand(command: string): string {
	const script = [
		command,
		"status=$?",
		"printf '\\n[spawn command exited with %s]\\n' \"$status\"",
		'exec "$' + '{SHELL:-bash}" -l',
	].join("\n");
	return `bash -lc ${shellQuote(script)}`;
}

async function writePromptArtifact(request: SpawnRequest, prompt: string): Promise<string> {
	if (!prompt) return "";
	const dir = await mkdtemp(join(tmpdir(), "pi-spawn-"));
	const promptPath = join(dir, `${request.name}.md`);
	await writeFile(promptPath, prompt, "utf8");
	return promptPath;
}

class PiRuntimeAdapter {
	readonly id = "pi" as const;

	parentRef(ctx: ExtensionContext, request: SpawnRequest): PiSessionRef | undefined {
		if (request.relation !== "child") return undefined;
		const parentSessionPath = request.targetSessionPath ?? ctx.sessionManager.getSessionFile?.();
		if (!parentSessionPath) return undefined;
		const header = request.targetSessionPath ? sessionHeader(parentSessionPath) : undefined;
		return {
			sessionPath: parentSessionPath,
			cwd: typeof header?.cwd === "string" ? header.cwd : ctx.cwd,
			name: request.targetSessionPath
				? sessionName("", parentSessionPath)
				: ctx.sessionManager.getSessionName?.() || "parent",
		};
	}

	async createSessionFile(
		ctx: ExtensionContext,
		request: SpawnRequest,
		parentSessionPath?: string,
	): Promise<PiSessionRef> {
		const timestamp = new Date().toISOString();
		const id = randomUUID();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const sessionPath = join(ctx.sessionManager.getSessionDir(), `${fileTimestamp}_${id}.jsonl`);
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: request.cwd,
			...(parentSessionPath ? { parentSession: parentSessionPath } : {}),
		};
		await writeFile(sessionPath, `${JSON.stringify(header)}\n`, "utf8");
		return { sessionPath, parentSessionPath, cwd: request.cwd, name: request.name };
	}

	async newSession(
		ctx: SpawnCommandContext,
		request: SpawnRequest,
		prompt: string,
		parent?: PiSessionRef,
		laneId?: string,
	): Promise<{ cancelled: boolean; child?: PiSessionRef }> {
		if (typeof ctx.newSession !== "function")
			throw new Error("new-session placement requires an interactive /spawn command");
		if (request.waitForIdle && !ctx.isIdle()) await ctx.waitForIdle?.();
		const parentSessionPath = parent?.sessionPath;
		let childSessionPath = "";
		const result = await ctx.newSession({
			parentSession: parentSessionPath,
			setup: async (sm: any) => {
				childSessionPath = sm.getSessionFile?.() ?? "";
				sm.appendSessionInfo?.(request.name);
				sm.appendCustomEntry?.(SPAWN_ENTRY_TYPE, {
					id: laneId,
					runtime: "pi",
					relation: request.relation,
					payload: request.payload,
					placement: request.placement,
					splitDirection: request.splitDirection,
					splitSizePercent: request.splitSizePercent,
					targetSessionPath: request.targetSessionPath,
					targetMuxSession: request.targetMuxSession,
					mux: "none",
					parent,
					child: {
						runtime: "pi",
						sessionPath: childSessionPath,
						parentSessionPath,
						cwd: request.cwd,
						name: request.name,
					},
					promptPath: "",
					goal: request.goal,
					createdAt: Date.now(),
					implementation: {
						runtime: {
							runtime: "pi",
							sessionPath: childSessionPath,
							parentSessionPath,
							cwd: request.cwd,
							name: request.name,
						},
						mux: { mux: "none" },
					},
				});
			},
			withSession: async (replacementCtx: ExtensionContext) => {
				if (prompt) await (replacementCtx as any).sendUserMessage(prompt);
				replacementCtx.ui.notify(`${request.relation === "root" ? "Root" : "Child"} spawn opened.`, "info");
			},
		});
		if (result.cancelled) return { cancelled: true };
		return {
			cancelled: false,
			child: { sessionPath: childSessionPath, parentSessionPath, cwd: request.cwd, name: request.name },
		};
	}
}

class TmuxMuxAdapter {
	readonly id = "tmux" as const;

	async tmux(pi: ExtensionAPI, args: string[]) {
		const result = await pi.exec("tmux", args, { timeout: 10_000 });
		if (result.code !== 0)
			throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux ${args.join(" ")} failed`);
		return result.stdout.trim();
	}

	async available(pi: ExtensionAPI): Promise<boolean> {
		const result = await pi.exec("tmux", ["display-message", "-p", "#S"], { timeout: 2_000 });
		return result.code === 0;
	}

	async targetSession(pi: ExtensionAPI, request: SpawnRequest): Promise<string> {
		return request.targetMuxSession || (await this.tmux(pi, ["display-message", "-p", "#S"]));
	}

	async nextWindowTarget(pi: ExtensionAPI, session: string): Promise<string> {
		const [baseIndexOutput, windowsOutput] = await Promise.all([
			this.tmux(pi, ["show-options", "-gv", "-t", session, "base-index"]).catch(() => "0"),
			this.tmux(pi, ["list-windows", "-t", session, "-F", "#{window_index}"]),
		]);
		const baseIndex = Number.parseInt(baseIndexOutput.trim(), 10);
		const used = new Set(
			windowsOutput
				.split("\n")
				.map((line) => Number.parseInt(line.trim(), 10))
				.filter((index) => Number.isFinite(index)),
		);
		let index = Number.isFinite(baseIndex) ? baseIndex : 0;
		while (used.has(index)) index += 1;
		return `${session}:${index}`;
	}

	splitDirectionArgs(request: SpawnRequest): string[] {
		if (request.splitDirection === "horizontal") return ["-h"];
		if (request.splitDirection === "vertical") return ["-v"];
		return [];
	}

	splitSizeArgs(request: SpawnRequest): string[] {
		return request.splitSizePercent === undefined ? [] : ["-p", String(request.splitSizePercent)];
	}

	async place(pi: ExtensionAPI, request: SpawnRequest, command: string): Promise<MuxPlacementRef> {
		const session = await this.targetSession(pi, request);
		if (request.placement === "new-window") {
			const target = await this.nextWindowTarget(pi, session);
			const paneId = await this.tmux(pi, [
				"new-window",
				"-P",
				"-F",
				"#{pane_id}",
				"-t",
				target,
				"-n",
				request.name,
				"-c",
				request.cwd,
				command,
			]);
			return {
				mux: "tmux",
				tmux: { session, windowId: target, windowName: request.name, paneId, placement: "new-window" },
			};
		}

		const currentWindow = request.targetMuxSession
			? `${session}:`
			: await this.tmux(pi, ["display-message", "-p", "#S:#I"]).catch(() => session);
		const targetArgs = request.targetMuxSession ? ["-t", currentWindow] : [];
		const paneId = await this.tmux(pi, [
			"split-window",
			...this.splitDirectionArgs(request),
			...this.splitSizeArgs(request),
			"-P",
			"-F",
			"#{pane_id}",
			...targetArgs,
			"-c",
			request.cwd,
			command,
		]);
		return {
			mux: "tmux",
			tmux: {
				session,
				windowId: currentWindow,
				windowName: request.name,
				paneId,
				placement: "split-pane",
				splitDirection: request.splitDirection,
				splitSizePercent: request.splitSizePercent,
			},
		};
	}
}

async function detectCapabilities(pi: ExtensionAPI): Promise<SpawnCapabilities> {
	const hasTmux = await new TmuxMuxAdapter().available(pi);
	return {
		runtimes: { pi: true, shell: true, command: true },
		muxes: { none: true, tmux: hasTmux },
		placements: {
			"new-session": true,
			"new-window": hasTmux,
			"split-pane": hasTmux,
		},
	};
}

function resolveRuntime(request: SpawnRequest, capabilities: SpawnCapabilities): ResolvedSpawnRuntime {
	const runtime = request.runtime;
	if (runtime !== "pi" && runtime !== "shell" && runtime !== "command")
		throw new Error(`Unsupported runtime: ${request.runtime}`);
	if (!capabilities.runtimes[runtime]) throw new Error(`${runtime} runtime is unavailable`);
	return runtime;
}

function resolveMux(
	request: SpawnRequest,
	runtime: ResolvedSpawnRuntime,
	capabilities: SpawnCapabilities,
): ResolvedSpawnMux {
	if (runtime !== "pi" && request.placement === "new-session")
		throw new Error(`${runtime} runtime requires new-window or split-pane placement`);
	if (request.placement === "new-session") return "none";
	const mux = request.mux === "auto" ? "tmux" : request.mux;
	if (mux !== "tmux") throw new Error(`${request.placement} placement requires a multiplexer`);
	if (!capabilities.muxes.tmux)
		throw new Error(`${request.placement} placement requires tmux, but tmux is unavailable`);
	return "tmux";
}

function validateRuntimeRequest(request: SpawnRequest, runtime: ResolvedSpawnRuntime) {
	if (runtime === "pi") {
		if (request.command) throw new Error("Pi runtime does not accept command; use runtime='command'");
		return;
	}
	if (request.payload !== "empty") throw new Error(`${runtime} runtime only supports payload='empty'`);
	if (request.targetSessionPath) throw new Error(`${runtime} runtime does not support targetSessionPath`);
	if (runtime === "shell" && request.command)
		throw new Error("shell runtime does not accept command; use runtime='command'");
	if (runtime === "command" && !request.command) throw new Error("command runtime requires command");
}

function requireParent(ctx: ExtensionContext, request: SpawnRequest): string | undefined {
	if (request.relation === "root") return undefined;
	if (request.targetSessionPath) return request.targetSessionPath;
	const parentSession = ctx.sessionManager.getSessionFile?.();
	if (!parentSession) throw new Error("Current session is not persisted; cannot create a linked child session");
	return parentSession;
}

async function spawn(
	pi: ExtensionAPI,
	input: Partial<SpawnRequest>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SpawnResult> {
	const request = normalizeSpawnRequest(input, ctx);
	const capabilities = await detectCapabilities(pi);
	const runtime = resolveRuntime(request, capabilities);
	const mux = resolveMux(request, runtime, capabilities);
	validateRuntimeRequest(request, runtime);
	if (!capabilities.placements[request.placement]) throw new Error(`${request.placement} placement is unavailable`);

	const piRuntime = new PiRuntimeAdapter();
	const parentSessionPath = runtime === "pi" ? requireParent(ctx, request) : undefined;
	const parent = runtime === "pi" ? piRuntime.parentRef(ctx, request) : undefined;
	const laneId = randomUUID();
	const createdAt = Date.now();
	const { prompt, promptGoal } =
		runtime === "pi"
			? await buildSpawnPayload(request, ctx, signal)
			: { prompt: "", promptGoal: request.goal || request.command || request.name };
	request.goal = promptGoal;

	if (request.placement === "new-session") {
		const placed = await piRuntime.newSession(ctx as SpawnCommandContext, request, prompt, parent, laneId);
		if (placed.cancelled || !placed.child) throw new Error("New session cancelled");
		return {
			id: laneId,
			runtime,
			relation: request.relation,
			payload: request.payload,
			placement: request.placement,
			splitDirection: request.splitDirection,
			splitSizePercent: request.splitSizePercent,
			targetSessionPath: request.targetSessionPath,
			targetMuxSession: request.targetMuxSession,
			mux,
			parent,
			child: {
				runtime: "pi",
				sessionPath: placed.child.sessionPath,
				parentSessionPath: placed.child.parentSessionPath,
				cwd: placed.child.cwd,
				name: placed.child.name,
			},
			promptPath: "",
			goal: request.goal,
			createdAt,
			implementation: {
				runtime: {
					runtime: "pi",
					sessionPath: placed.child.sessionPath,
					parentSessionPath: placed.child.parentSessionPath,
					cwd: placed.child.cwd,
					name: placed.child.name,
				},
				mux: { mux: "none" },
			},
		};
	}

	if (runtime !== "pi") {
		const child: SpawnLaneRef = { runtime, cwd: request.cwd, name: request.name, command: request.command };
		const processCommand = runtime === "shell" ? shellSpawnCommand() : commandSpawnCommand(request.command || "");
		const muxRef = await new TmuxMuxAdapter().place(pi, request, processCommand);
		const result: SpawnResult = {
			id: laneId,
			runtime,
			relation: "root",
			payload: "empty",
			placement: request.placement,
			splitDirection: request.splitDirection,
			splitSizePercent: request.splitSizePercent,
			targetSessionPath: undefined,
			targetMuxSession: request.targetMuxSession,
			mux,
			parent: undefined,
			child,
			command: request.command,
			promptPath: "",
			goal: request.goal,
			createdAt,
			implementation: { runtime: child, mux: muxRef },
		};
		pi.appendEntry(SPAWN_ENTRY_TYPE, result);
		return result;
	}

	const child = await piRuntime.createSessionFile(ctx, request, parentSessionPath);
	const promptPath = await writePromptArtifact(request, prompt);
	const lane: SpawnLaneRef = {
		runtime: "pi",
		sessionPath: child.sessionPath,
		parentSessionPath: child.parentSessionPath,
		cwd: child.cwd,
		name: child.name,
	};
	const muxRef = await new TmuxMuxAdapter().place(pi, request, piSpawnCommand(child.sessionPath, promptPath));
	const result: SpawnResult = {
		id: laneId,
		runtime,
		relation: request.relation,
		payload: request.payload,
		placement: request.placement,
		splitDirection: request.splitDirection,
		splitSizePercent: request.splitSizePercent,
		targetSessionPath: request.targetSessionPath,
		targetMuxSession: request.targetMuxSession,
		mux,
		parent,
		child: lane,
		promptPath,
		goal: request.goal,
		createdAt,
		implementation: { runtime: lane, mux: muxRef },
	};
	pi.appendEntry(SPAWN_ENTRY_TYPE, result);
	return result;
}

function isSpawnLaneEntry(value: unknown): value is SpawnLaneEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		(entry.runtime === "pi" || entry.runtime === "shell" || entry.runtime === "command") &&
		(entry.relation === "root" || entry.relation === "child") &&
		(entry.payload === "empty" || entry.payload === "direct" || entry.payload === "context") &&
		(entry.placement === "new-session" || entry.placement === "new-window" || entry.placement === "split-pane") &&
		typeof entry.child === "object" &&
		typeof entry.createdAt === "number"
	);
}

function spawnLaneEntries(ctx: ExtensionContext): SpawnLaneEntry[] {
	return ctx.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom" && entry.customType === SPAWN_ENTRY_TYPE && isSpawnLaneEntry(entry.data),
		)
		.map((entry) => entry.data as SpawnLaneEntry)
		.sort((a, b) => b.createdAt - a.createdAt);
}

function formatSpawnLaneEntries(entries: SpawnLaneEntry[]): string {
	if (entries.length === 0) return "No spawned lanes recorded in this session.";

	return entries
		.map((entry, index) => {
			const created = new Date(entry.createdAt).toLocaleString();
			const tmuxRef = entry.implementation?.mux?.tmux;
			return [
				`## ${index + 1}. ${entry.child.name}`,
				`- ID: ${entry.id}`,
				`- Runtime: ${entry.runtime}`,
				`- Payload: ${entry.payload}`,
				`- Relation: ${entry.relation}`,
				`- Placement: ${entry.placement}`,
				entry.splitDirection ? `- Split direction: ${entry.splitDirection}` : undefined,
				entry.splitSizePercent !== undefined ? `- Split size: ${entry.splitSizePercent}%` : undefined,
				entry.targetSessionPath ? `- Target parent session: ${entry.targetSessionPath}` : undefined,
				entry.targetMuxSession ? `- Target mux session: ${entry.targetMuxSession}` : undefined,
				`- Mux: ${entry.mux}`,
				`- Goal: ${entry.goal || "(none)"}`,
				entry.command ? `- Command: ${entry.command}` : undefined,
				entry.child.sessionPath ? `- Child session: ${entry.child.sessionPath}` : undefined,
				entry.parent?.sessionPath ? `- Parent session: ${entry.parent.sessionPath}` : undefined,
				entry.promptPath ? `- Prompt: ${entry.promptPath}` : undefined,
				tmuxRef?.paneId ? `- Pane: ${tmuxRef.paneId}` : undefined,
				tmuxRef?.windowId ? `- Window: ${tmuxRef.windowId}` : undefined,
				`- Cwd: ${entry.child.cwd}`,
				`- Created: ${created}`,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}

function readSessionJsonLines(path: string, maxLines = 2000): any[] {
	if (!path) return [];
	try {
		return String(readFileSync(path, "utf8"))
			.split("\n")
			.slice(0, maxLines)
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return undefined;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

function sessionHeader(path: string): any {
	return readSessionJsonLines(path, 1)[0] ?? {};
}

function sessionFiles(ctx: ExtensionContext): string[] {
	const root = ctx.sessionManager.getSessionDir?.() ?? "";
	if (!root) return [];
	const out: string[] = [];
	const visit = (dir: string, depth = 0) => {
		if (depth > 4 || out.length > 3000) return;
		let entries: any[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) visit(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					if (statSync(path).size > 0) out.push(path);
				} catch {}
			}
		}
	};
	visit(root);
	return out;
}

function childSessions(files: string[], parent: string): string[] {
	return files.filter((path) => sessionHeader(path).parentSession === parent).sort();
}

function spawnedName(parent: string, child: string): string {
	const lane = readSessionJsonLines(parent)
		.filter((entry) => entry.type === "custom" && entry.customType === SPAWN_ENTRY_TYPE)
		.map((entry) => entry.data ?? {})
		.find((data) => data.child?.sessionPath === child || data.child?.sessionPath === child);
	return lane?.child?.name || lane?.goal || "";
}

function sessionTitle(path: string): string {
	const firstUser = readSessionJsonLines(path, 80).find((entry) => entry.message?.role === "user");
	const text = firstUser?.message?.content?.find?.((item: any) => item?.type === "text")?.text ?? "";
	return (
		String(text)
			.replace(/[`*_#>]/g, "")
			.trim() || "session"
	);
}

function sessionName(parent: string, child: string): string {
	return (parent ? spawnedName(parent, child) : "") || sessionTitle(child);
}

function shortName(value: string): string {
	return String(value).replace(/\s+/g, "-").slice(0, 24);
}

function subagentCount(path: string): number {
	return readSessionJsonLines(path).reduce((count, entry) => {
		const content = entry.message?.content;
		if (!Array.isArray(content)) return count;
		return count + content.filter((item) => item?.type === "toolCall" && item?.name === "subagent").length;
	}, 0);
}

function formatSpawnMap(ctx: ExtensionContext): string {
	const C = { accent: "\x1b[38;2;203;166;247m", muted: "\x1b[38;2;88;91;112m", R: "\x1b[0m" };
	const current = ctx.sessionManager.getSessionFile?.() ?? "";
	if (!current) return "No persisted session file; spawn map is unavailable.";
	const files = Array.from(new Set([...sessionFiles(ctx), current].filter(Boolean)));

	const ancestors: string[] = [];
	const seen = new Set<string>();
	let cursor = current;
	while (cursor && !seen.has(cursor) && ancestors.length < 8) {
		seen.add(cursor);
		ancestors.unshift(cursor);
		const parent = sessionHeader(cursor).parentSession;
		cursor = typeof parent === "string" ? parent : "";
		if (cursor && !files.includes(cursor)) files.push(cursor);
	}

	const root = ancestors[0] ?? current;
	const lines: string[] = [];
	const renderNode = (path: string, parent: string, prefix = "", isLast = true, depth = 0) => {
		if (depth > 8) {
			lines.push(`${prefix}${isLast ? "└─" : "├─"} …`);
			return;
		}
		const connector = depth === 0 ? "" : isLast ? "└─ " : "├─ ";
		const name = sessionName(parent, path);
		const children = childSessions(files, path);
		const line = `${prefix}${connector}${shortName(name)} (🧵${children.length} 🤖${subagentCount(path)})`;
		lines.push(path === current ? `${C.accent}${line}${C.R}` : `${C.muted}${line}${C.R}`);
		const nextPrefix = depth === 0 ? "" : `${prefix}${isLast ? "   " : "│  "}`;
		children.forEach((child, index) => {
			renderNode(child, path, nextPrefix, index === children.length - 1, depth + 1);
		});
	};

	renderNode(root, "");
	return lines.join("\n");
}

function spawnResultText(result: SpawnResult): string {
	const tmuxRef = result.implementation?.mux?.tmux;
	return [
		`Spawned ${result.runtime === "pi" ? result.payload : result.runtime} ${result.relation} lane: ${result.child.name}`,
		result.child.sessionPath ? `Session: ${result.child.sessionPath}` : undefined,
		result.parent?.sessionPath ? `Parent: ${result.parent.sessionPath}` : undefined,
		result.targetSessionPath && result.targetSessionPath !== result.parent?.sessionPath
			? `Target parent session: ${result.targetSessionPath}`
			: undefined,
		result.splitDirection ? `Split direction: ${result.splitDirection}` : undefined,
		result.splitSizePercent !== undefined ? `Split size: ${result.splitSizePercent}%` : undefined,
		result.targetMuxSession ? `Target mux session: ${result.targetMuxSession}` : undefined,
		result.command ? `Command: ${result.command}` : undefined,
		result.promptPath ? `Prompt: ${result.promptPath}` : undefined,
		tmuxRef?.paneId ? `Pane: ${tmuxRef.paneId}` : undefined,
		tmuxRef?.windowId ? `Window: ${tmuxRef.windowId}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function sendCustom(pi: ExtensionAPI, customType: string, content: string) {
	pi.sendMessage({ customType, content, display: true }, { triggerTurn: false });
}

async function handleSpawnCommand(pi: ExtensionAPI, args: string, ctx: SpawnCommandContext) {
	const trimmed = args.trim();
	const [subcommand] = tokenizeArgs(trimmed);
	if (subcommand === "list") {
		sendCustom(pi, "spawn-list", formatSpawnLaneEntries(spawnLaneEntries(ctx)));
		return;
	}
	if (subcommand === "map") {
		sendCustom(pi, "spawn-map", formatSpawnMap(ctx));
		return;
	}
	if (subcommand === "status") {
		const entries = spawnLaneEntries(ctx);
		sendCustom(
			pi,
			"spawn-status",
			entries[0] ? formatSpawnLaneEntries(entries.slice(0, 1)) : "No spawned lanes recorded in this session.",
		);
		return;
	}

	if (!trimmed && !ctx.hasUI) {
		ctx.ui.notify(
			"Usage: /spawn direct|context|empty [child|root] ...; /spawn shell|bash ...; /spawn command|run ... -- <command>; /spawn list|map|status",
			"warning",
		);
		return;
	}

	try {
		const request = trimmed ? parseSpawnRequest(trimmed, ctx) : await promptSpawnRequest(ctx);
		if (!request) {
			ctx.ui.notify("Spawn cancelled", "info");
			return;
		}
		const result = await spawn(pi, request, ctx);
		ctx.ui.notify(spawnResultText(result), "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			`Spawn failed: ${message}`,
			message === "Spawn cancelled" || message === "New session cancelled" ? "info" : "error",
		);
	}
}

function toolRequest(params: NormalizedToolParams, ctx: ExtensionContext): Partial<SpawnRequest> {
	const runtime = params.runtime
		? parseRuntimeOrThrow(params.runtime.toLowerCase(), "runtime")
		: params.command
			? "command"
			: params.payload === "direct" || params.payload === "context"
				? "pi"
				: "shell";
	const payload =
		parsePayload(params.payload?.toLowerCase()) ??
		(runtime === "shell" || runtime === "command" ? "empty" : "direct");
	const relation =
		parseRelation(params.relation?.toLowerCase()) ??
		(runtime === "shell" || runtime === "command" ? "root" : "child");
	const placement = parsePlacement(params.placement?.toLowerCase()) ?? "new-window";
	const splitDirection = parseSplitDirection(params.splitDirection?.toLowerCase());
	const splitSizePercent = parseSplitSizePercent(params.splitSizePercent);
	const mux = parseMux(params.mux?.toLowerCase()) ?? "auto";
	const prompt = params.prompt ?? "";
	const command = params.command?.trim() || undefined;
	const goal = params.goal || prompt || command || "";
	return normalizeSpawnRequest(
		{
			runtime,
			payload,
			relation,
			placement,
			splitDirection,
			splitSizePercent,
			targetSessionPath: params.targetSessionPath ? resolve(ctx.cwd, params.targetSessionPath) : undefined,
			targetMuxSession: params.targetMuxSession,
			mux,
			command,
			cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd,
			name: params.name ?? "",
			prompt,
			goal,
			reviewPrompt: false,
			waitForIdle: false,
		},
		ctx,
	);
}

const SPAWN_TOOL_NAMES = ["spawn_lane", "spawn_list", "spawn_map"];

function hasExistingSpawnSurface(pi: ExtensionAPI): boolean {
	const toolNames = new Set(pi.getAllTools().map((tool) => tool.name));
	if (SPAWN_TOOL_NAMES.some((name) => toolNames.has(name))) return true;
	return pi.getCommands().some((command) => command.name === "spawn");
}

function registerSpawnSurface(pi: ExtensionAPI) {
	pi.registerTool({
		name: "spawn_lane",
		label: "Spawn lane",
		description: [
			"Spawn an execution lane without raw tmux. Use runtime='pi' for agent lanes, runtime='shell' for a fresh shell, or runtime='command' with command for a process lane.",
			"For Pi lanes, use payload='direct' for a self-contained bounded task; payload='context' when the new lane needs current conversation context; payload='empty' for a blank lane.",
			"Use placement='new-window' for durable parallel work, placement='split-pane' for quick parallel iteration, and placement='new-session' only from /spawn because tools cannot replace the active session.",
			"For split panes, use splitDirection='horizontal' or 'vertical' and optional splitSizePercent=10..90, e.g. 30 for a 30% split.",
			"Use cwd for a target repo/project. Use relation='root' for unrelated or cross-project lanes unless targetSessionPath explicitly names the parent session for relation='child'. Use targetMuxSession to place the lane in another tmux session/workspace.",
		].join(" "),
		promptSnippet: "Spawn a lane",
		parameters: Type.Object({
			runtime: Type.Optional(
				Type.String({
					description: "pi, shell, or command. Defaults to shell unless payload or command implies a runtime.",
				}),
			),
			payload: Type.Optional(
				Type.String({
					description: "empty, direct, or context. Defaults to empty for shell/command and direct for pi.",
				}),
			),
			relation: Type.Optional(
				Type.String({ description: "child or root. Defaults to root for shell/command and child for pi." }),
			),
			placement: Type.Optional(
				Type.String({
					description:
						"new-window, split-pane, or new-session. Tools should usually use new-window or split-pane.",
				}),
			),
			splitDirection: Type.Optional(
				Type.String({ description: "horizontal or vertical for split-pane placement." }),
			),
			splitSizePercent: Type.Optional(
				Type.Number({
					description:
						"Optional split size percent for split-pane placement, integer 10-90. For tmux this maps to split-window -p.",
				}),
			),
			targetSessionPath: Type.Optional(
				Type.String({
					description:
						"Advanced Pi parent session path. When relation=child, this overrides the current session as parent.",
				}),
			),
			targetMuxSession: Type.Optional(
				Type.String({
					description: "Target mux/tmux session or workspace for placement outside the current mux session.",
				}),
			),
			mux: Type.Optional(Type.String({ description: "auto, tmux, or none. Defaults to auto." })),
			command: Type.Optional(Type.String({ description: "Command to run when runtime='command'." })),
			prompt: Type.Optional(
				Type.String({
					description: "Direct prompt, or a prebuilt context-transfer prompt when payload is context.",
				}),
			),
			goal: Type.Optional(Type.String({ description: "Goal used for naming and context generation." })),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current cwd." })),
			name: Type.Optional(Type.String({ description: "Lane name; inferred from goal/prompt when omitted." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = toolRequest(params as NormalizedToolParams, ctx);
			if (request.placement === "new-session")
				throw new Error(
					"spawn_lane placement='new-session' requires the /spawn command; use new-window or split-pane from tools.",
				);
			const result = await spawn(pi, request, ctx, signal);
			return { content: [{ type: "text", text: spawnResultText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "spawn_list",
		label: "List spawned lanes",
		description: "List canonical spawn-lane entries recorded in the current Pi session.",
		promptSnippet: "List spawned lanes",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const lanes = spawnLaneEntries(ctx);
			return { content: [{ type: "text", text: formatSpawnLaneEntries(lanes) }], details: { lanes } };
		},
	});

	pi.registerTool({
		name: "spawn_map",
		label: "Spawn map",
		description: "Show the current spawn family as a Pi parent/child session tree.",
		promptSnippet: "Show spawn map",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const map = formatSpawnMap(ctx);
			return { content: [{ type: "text", text: map }], details: { map } };
		},
	});

	pi.registerCommand("spawn", {
		description:
			"Spawn an execution lane. Usage: /spawn direct|context|empty [child|root] ...; /spawn shell|bash ...; /spawn command|run ... -- <command>; /spawn list|map|status",
		handler: async (args, ctx) => {
			await handleSpawnCommand(pi, args, ctx as SpawnCommandContext);
		},
	});
}

export default function spawnExtension(pi: ExtensionAPI) {
	let registered = false;
	pi.on("session_start", () => {
		if (registered || hasExistingSpawnSurface(pi)) return;
		registerSpawnSurface(pi);
		registered = true;
	});
}
