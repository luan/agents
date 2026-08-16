import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadModelRoles, roleColor, roleNames } from "../model-roles/catalog.js";
import { toolRegistrarFor } from "../shared/tool-registry.ts";
import { findRetryableError } from "./runtime/agent-runner.js";
import {
	type CoordinatorUpdate,
	createRootCoordinator,
	getCoordinatorForSession,
	latestSubagentTreeCheckpoint,
	loadSubagentConfig,
	removeRootCoordinator,
	SUBAGENT_STATE_ENTRY_TYPE,
	type SubagentCoordinator,
	type SubagentSnapshot,
	type TranscriptSource,
} from "./runtime/coordinator.js";
import type { ForkTurns } from "./runtime/fork-history.js";
import type { AgentConfig } from "./runtime/types.js";
import { type AgentHubSnapshot, type AgentHubSnapshotSource, openAgentHub } from "./runtime/ui/agent-browser.js";
import { AgentWidget } from "./runtime/ui/agent-widget.js";
import { getPresentationResolver, unregisterPresentationResolver } from "./runtime/ui/presentation-resolver.js";
import {
	createWaitToolPresentation,
	followupToolPresentation,
	interruptToolPresentation,
	listAgentsPresentation,
	sendMessageToolPresentation,
	spawnToolPresentation,
} from "./runtime/ui/tool-presentations.ts";
import { AGENT_TOOLS } from "./tool-names.ts";

type TaskParams = { task_name: string; message: string; fork_turns?: string; model_role?: string };
type TaskItem = { task_name: string; model_role?: string; message: string };
export type TaskResult = {
	id: string;
	model_role?: string;
	model_role_color?: string;
	message?: string;
	status: SubagentSnapshot["status"];
	output?: string;
	error?: string;
	durationMs: number;
	toolUses: number;
};

const taskAgentConfig: AgentConfig = {};
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;
const RETRY_MESSAGE = "retry-failed-request";
const REPEAT_LIMIT = 3;

export function normalizeTaskName(value: string): string {
	const name = value.trim();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
		throw new Error("task_name must use lowercase letters, digits, and single dashes between words");
	return name;
}

export function normalizeItems(params: TaskParams): TaskItem[] {
	const message = params.message?.trim();
	if (!message) throw new Error("subagent requires message");
	return [{ task_name: normalizeTaskName(params.task_name), model_role: params.model_role, message }];
}

export function parseForkTurns(value: string | undefined): ForkTurns {
	const forkTurns = value?.trim() || "all";
	if (forkTurns === "all" || forkTurns === "none") return forkTurns;
	if (/^[1-9]\d*$/.test(forkTurns)) {
		const count = Number(forkTurns);
		if (Number.isSafeInteger(count)) return count;
	}
	throw new Error("fork_turns must be none, all, or a positive integer string");
}

export function withModelRole(agent: AgentConfig, modelRole: string | undefined): AgentConfig {
	const role = modelRole?.trim();
	return role ? { ...agent, role } : agent;
}

function waitTimeout(requestedMs: number | undefined): number {
	const requested = Number.isFinite(requestedMs) ? (requestedMs as number) : DEFAULT_WAIT_TIMEOUT_MS;
	return Math.min(Math.max(MIN_WAIT_TIMEOUT_MS, requested), MAX_WAIT_TIMEOUT_MS);
}

function resultFromSnapshot(
	agent: SubagentSnapshot,
	modelRole?: string,
	message?: string,
	modelRoleColor?: string,
): TaskResult {
	return {
		id: agent.id,
		model_role: modelRole,
		model_role_color: modelRoleColor,
		message,
		status: agent.status,
		output: agent.result,
		error: agent.error,
		durationMs: (agent.completedAt ?? Date.now()) - agent.startedAt,
		toolUses: agent.toolUses,
	};
}

type AgentToolDefinition = { name: string; execute: (...args: never[]) => unknown; [key: string]: unknown };

function outcomeKey(tool: string, args: unknown, outcome: string): string {
	let signature: string;
	try {
		signature = JSON.stringify(args) ?? "";
	} catch {
		signature = String(args);
	}
	return JSON.stringify([tool, signature, outcome]);
}

export function createAgentCallBreaker(limit = REPEAT_LIMIT) {
	const bySession = new Map<string, Map<string, number>>();
	return {
		observe(session: string, tool: string, args: unknown, outcome: string): string | undefined {
			const key = outcomeKey(tool, args, outcome);
			let counts = bySession.get(session);
			if (!counts) {
				counts = new Map();
				bySession.set(session, counts);
			}
			const count = (counts.get(key) ?? 0) + 1;
			if (count === 1) counts.clear();
			counts.set(key, count);
			if (count < limit) return undefined;
			return `This identical ${tool} call has now produced the same outcome ${count} times and will keep doing so. Stop calling ${tool} with these arguments.`;
		},
	};
}

type AgentCallBreaker = ReturnType<typeof createAgentCallBreaker>;
function appendOutcomeNote(result: unknown, note: string): unknown {
	const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
	const last = Array.isArray(content) ? [...content].reverse().find((part) => part?.type === "text") : undefined;
	if (!last) return result;
	last.text = `${last.text ?? ""}\n\n${note}`;
	return result;
}

export function withRepeatBreaker(definition: AgentToolDefinition, breaker: AgentCallBreaker): AgentToolDefinition {
	const inner = definition.execute;
	return {
		...definition,
		async execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const session = ctx.sessionManager.getSessionId();
			try {
				const result = await (inner as (...args: unknown[]) => unknown).call(
					definition,
					toolCallId,
					params,
					signal,
					onUpdate,
					ctx,
				);
				const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
				const text = Array.isArray(content) ? (content.find((part) => part?.type === "text")?.text ?? "") : "";
				const note = breaker.observe(session, definition.name, params, text);
				return note ? appendOutcomeNote(result, note) : result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const note = breaker.observe(session, definition.name, params, message);
				throw note ? new Error(`${message}\n${note}`) : error;
			}
		},
	} as AgentToolDefinition;
}

class CoordinatorSnapshotSource implements AgentHubSnapshotSource {
	private generation = 0;
	private snapshot: AgentHubSnapshot;
	private readonly transcripts = new Map<string, TranscriptSource>();
	private readonly listeners = new Set<(snapshot: AgentHubSnapshot) => void>();
	private readonly unsubscribe: () => void;
	constructor(private readonly coordinator: SubagentCoordinator) {
		this.snapshot = this.buildSnapshot();
		this.unsubscribe = coordinator.subscribe((event) => {
			if (event.type === "transcript") return;
			this.generation++;
			this.snapshot = this.buildSnapshot();
			for (const listener of [...this.listeners]) listener(this.snapshot);
		});
	}
	getSnapshot(): AgentHubSnapshot {
		return this.snapshot;
	}
	subscribe(listener: (snapshot: AgentHubSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	dispose(): void {
		this.unsubscribe();
		this.listeners.clear();
		this.transcripts.clear();
	}
	private buildSnapshot(): AgentHubSnapshot {
		const agents = this.coordinator.snapshot().map((agent) => {
			let transcript = this.transcripts.get(agent.id);
			if (!transcript) {
				transcript = this.coordinator.transcript(agent.id);
				if (!transcript) throw new Error(`Transcript unavailable for ${agent.id}`);
				this.transcripts.set(agent.id, transcript);
			}
			return { ...agent, transcript };
		});
		return Object.freeze({ generation: this.generation, agents: Object.freeze(agents) });
	}
}

function collaborationInstructions(maxConcurrency: number, maxDepth: number): string {
	return `<root_agent_context>\nYou are /root, the primary agent in one root-scoped agent tree.\nThere are ${maxConcurrency} concurrent agent slots including you.\nSubagent nesting is limited to depth ${maxDepth}.\nUse collaboration tools only for concrete independent work.\n</root_agent_context>`;
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registerAgentTool = toolRegistrarFor(pi);
	const breaker = createAgentCallBreaker();
	const registerCollaborationTool = ((definition: unknown) => {
		registerAgentTool(withRepeatBreaker(definition as AgentToolDefinition, breaker) as never);
	}) as ExtensionAPI["registerTool"];
	const modelRoles = loadModelRoles();
	const config = loadSubagentConfig();
	const modelRoleDescription = Object.entries(modelRoles.roles)
		.map(([name, role]) => `${name}: ${role.description ?? "No description."}`)
		.join("; ");
	const modelRoleParameter = Object.keys(modelRoles.roles).length
		? Type.Union(
				Object.entries(modelRoles.roles).map(([name, role]) =>
					Type.Literal(name, { description: role.description ?? "No description." }),
				),
				{
					description: `Model role override for the new agent. Omit to use the configured subagent default role (${modelRoles.subagentDefaultRole}).`,
				},
			)
		: Type.String({
				description: `Model role override for the new agent. Omit to use the configured subagent default role (${modelRoles.subagentDefaultRole}).`,
			});
	let coordinator: SubagentCoordinator | undefined;
	let callerPath: string | undefined;
	let rootSessionId: string | undefined;
	let ownsRoot = false;
	let rootTurnActive = false;
	let source: CoordinatorSnapshotSource | undefined;
	let widget: AgentWidget | undefined;
	let unsubscribeDelivery: (() => void) | undefined;
	const persistedAgentStates = new Map<string, string>();

	const requireCoordinator = (): SubagentCoordinator => {
		if (!coordinator) throw new Error("Subagent coordinator is unavailable for this session");
		return coordinator;
	};
	const otherLiveAgents = () =>
		coordinator
			?.snapshot()
			.filter(
				(agent) =>
					(agent.status === "queued" || agent.status === "running") && agent.id !== (callerPath ?? "/root"),
			);
	const deliverRootMessages = () => {
		if (!ownsRoot || !coordinator) return;
		for (const message of coordinator.drainRootMessages()) {
			pi.sendMessage(
				{
					customType: "subagent-message",
					content: `Message Type: MESSAGE\nTask name: /root\nSender: ${message.sender}\nPayload:\n${message.message}`,
					display: false,
					details: message,
				},
				{ deliverAs: rootTurnActive ? "steer" : "nextTurn", triggerTurn: false },
			);
		}
	};
	const persistAgentState = (id: string, force = false) => {
		if (!ownsRoot || !coordinator) return;
		const agent = coordinator.persistedAgent(id);
		if (!agent) return;
		const serialized = JSON.stringify(agent);
		if (!force && serialized === persistedAgentStates.get(id)) return;
		pi.appendEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1 as const, agent });
		persistedAgentStates.set(id, serialized);
	};
	const persistAllAgentStates = (force = false) => {
		for (const agent of coordinator?.checkpoint().agents ?? []) persistAgentState(agent.id, force);
	};
	const routeCoordinatorUpdate = (event: CoordinatorUpdate) => {
		if (
			event.type === "spawned" ||
			event.type === "started" ||
			event.type === "checkpoint" ||
			event.type === "settled" ||
			event.type === "interrupted"
		) {
			persistAgentState(event.agent.id);
		}
		if (event.type === "message") {
			if (event.target === "/root") deliverRootMessages();
			return;
		}
	};
	const attachRootPresentation = (ctx: ExtensionContext) => {
		if (!coordinator) return;
		ownsRoot = true;
		source = new CoordinatorSnapshotSource(coordinator);
		unsubscribeDelivery = coordinator.subscribe(routeCoordinatorUpdate);
		if (ctx.hasUI) {
			widget = new AgentWidget(source);
			widget.setUICtx(ctx.ui);
		}
	};

	pi.on("before_agent_start", (event) => {
		if (!ownsRoot || event.systemPrompt.includes("<root_agent_context>")) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${collaborationInstructions(config.maxConcurrency, config.maxDepth)}`,
		};
	});
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = getCoordinatorForSession(sessionId);
		if (existing) {
			coordinator = existing;
			rootSessionId = existing.rootSessionId;
			callerPath = existing.pathForSession(sessionId);
			if (sessionId === existing.rootSessionId) attachRootPresentation(ctx);
			return;
		}
		coordinator = createRootCoordinator(sessionId, { ...config, rootSessionDir: ctx.sessionManager.getSessionDir() });
		rootSessionId = sessionId;
		callerPath = undefined;
		const checkpoint = latestSubagentTreeCheckpoint(ctx.sessionManager.getBranch());
		if (checkpoint) coordinator.restore(checkpoint, { pi, ctx });
		persistedAgentStates.clear();
		for (const agent of checkpoint?.agents ?? []) persistedAgentStates.set(agent.id, JSON.stringify(agent));
		attachRootPresentation(ctx);
	});
	pi.on("agent_start", () => {
		if (ownsRoot) rootTurnActive = true;
		deliverRootMessages();
	});
	pi.on("agent_end", () => {
		if (!ownsRoot) return;
		rootTurnActive = false;
	});
	pi.on("session_compact", () => persistAllAgentStates(true));
	pi.on("session_shutdown", (event, ctx) => {
		persistAllAgentStates(true);
		unregisterPresentationResolver(ctx.sessionManager.getSessionId());
		unsubscribeDelivery?.();
		widget?.dispose();
		source?.dispose();
		if (ownsRoot && rootSessionId && event.reason !== "reload") removeRootCoordinator(rootSessionId);
		coordinator = undefined;
		callerPath = undefined;
		rootSessionId = undefined;
		ownsRoot = false;
		persistedAgentStates.clear();
	});

	const openHub = async (ctx: ExtensionCommandContext) => {
		if (!ownsRoot || !source) return;
		const resolver = getPresentationResolver(ctx.sessionManager.getSessionId());
		await openAgentHub(ctx, source, resolver?.resolveTool, resolver?.resolveCustomMessage);
	};
	pi.registerCommand("subagents", {
		description: "Open the Agent Hub",
		handler: async (_args: string, ctx: ExtensionCommandContext) => openHub(ctx),
	});
	pi.registerShortcut?.("alt+a", {
		description: "Toggle the Agent Hub",
		handler: async (ctx: ExtensionContext) => openHub(ctx as ExtensionCommandContext),
	});
	pi.registerCommand("retry", {
		description: "Re-issue the failed request: /retry [main|<subagent id>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ctx.waitForIdle();
			const target = args.trim();
			const mainError = findRetryableError(ctx.sessionManager.getBranch());
			if (!target || target === "main") {
				if (!mainError) return ctx.ui.notify("No failed main-session request to re-issue.", "warning");
				pi.sendMessage(
					{
						customType: RETRY_MESSAGE,
						content: `The previous request failed (${mainError}). Continue from the last completed step without repeating finished work.`,
						display: false,
					},
					{ triggerTurn: true },
				);
				return;
			}
			const activeCoordinator = requireCoordinator();
			const canonical = activeCoordinator.resolve(callerPath, target);
			const agent = canonical
				? activeCoordinator.snapshot().find((candidate) => candidate.id === canonical)
				: undefined;
			if (!agent || agent.status !== "failed")
				return ctx.ui.notify(`No failed subagent matches "${target}".`, "warning");
			await activeCoordinator.followUp(
				callerPath,
				canonical!,
				"Retry the latest failed request without repeating completed work.",
			);
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.spawnAgent,
		label: "Spawn Agent",
		description:
			(modelRoleDescription ? `Model roles: ${modelRoleDescription}\n` : "") +
			`Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task-3" the agent will have canonical task name \`/root/task1/task-3\`.\nYou are then able to refer to this agent as \`task-3\` or \`/root/task1/task-3\` interchangeably. However an agent \`/root/task2/task-3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task-3\`.\nThe spawned agent will have the same tools as you and the ability to spawn its own subagents.\nOmit \`model_role\` to use the configured subagent default role (${modelRoles.subagentDefaultRole}).\nOnly call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.\nIt will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.\nThe new agent's canonical task name will be provided to it along with the message.\n\nNote that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`,
		...spawnToolPresentation,
		parameters: Type.Object(
			{
				task_name: Type.String({
					description: "Task name for the new agent. Use lowercase letters, digits, and dashes.",
				}),
				message: Type.String({ description: "Initial plain-text task for the new agent." }),
				fork_turns: Type.Optional(
					Type.String({
						description:
							"Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
					}),
				),
				model_role: Type.Optional(modelRoleParameter),
			},
			{ additionalProperties: false },
		),
		async execute(
			_toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback | undefined,
			ctx: ExtensionContext,
		) {
			const item = normalizeItems(params as TaskParams)[0]!;
			const requestedModelRole = item.model_role?.trim() || modelRoles.subagentDefaultRole;
			if (requestedModelRole && !modelRoles.roles[requestedModelRole])
				throw new Error(`Unknown model role: ${requestedModelRole}`);
			const requestedModelRoleColor = requestedModelRole
				? roleColor(modelRoles.roles[requestedModelRole]!, roleNames(modelRoles).indexOf(requestedModelRole))
				: undefined;
			const forkTurns = parseForkTurns((params as TaskParams).fork_turns);
			const activeCoordinator = requireCoordinator();
			const id = activeCoordinator.spawn(callerPath, {
				taskName: item.task_name,
				message: item.message,
				pi,
				ctx,
				agentConfig: withModelRole(taskAgentConfig, requestedModelRole),
				forkTurns,
				signal,
			});
			const agent = activeCoordinator.snapshot().find((candidate) => candidate.id === id)!;
			return {
				content: [
					{ type: "text" as const, text: `Started agent ${id} asynchronously. Use wait_agent for updates.` },
				],
				details: {
					result: resultFromSnapshot(agent, requestedModelRole, item.message, requestedModelRoleColor),
				},
			};
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.followupTask,
		label: "Follow Up Agent",
		description:
			"Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
		...followupToolPresentation,
		parameters: Type.Object(
			{
				target: Type.String({
					description: "Agent id or canonical task name to send a follow-up task to (from spawn_agent).",
				}),
				message: Type.String({ description: "Message text to send to the target agent." }),
			},
			{ additionalProperties: false },
		),
		async execute(_id: string, params: unknown) {
			const { target, message } = params as { target: string; message: string };
			if (target.trim() === "/root") throw new Error("Follow-up tasks can't target the root agent");
			await requireCoordinator().followUp(callerPath, target, message);
			return { content: [], details: {} };
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.sendMessage,
		label: "Send Agent Message",
		description:
			"Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
		...sendMessageToolPresentation,
		parameters: Type.Object(
			{
				target: Type.String({ description: "Relative or canonical task name to message (from spawn_agent)." }),
				message: Type.String({ description: "Message text to queue on the target agent." }),
			},
			{ additionalProperties: false },
		),
		async execute(_id: string, params: unknown) {
			const { target, message } = params as { target: string; message: string };
			const activeCoordinator = requireCoordinator();
			const canonical = target === "/root" ? "/root" : activeCoordinator.resolve(callerPath, target);
			const own = callerPath ?? "/root";
			if (!canonical) throw new Error(`No agent matches "${target}"`);
			if (canonical === own) throw new Error(`Agent ${own} cannot target itself`);
			await activeCoordinator.sendMessage(callerPath, canonical, message);
			return { content: [], details: {} };
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.interruptAgent,
		label: "Interrupt Agent",
		description:
			"Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
		...interruptToolPresentation,
		parameters: Type.Object(
			{ target: Type.String({ description: "Agent id or canonical task name to interrupt (from spawn_agent)." }) },
			{ additionalProperties: false },
		),
		async execute(_id: string, params: unknown) {
			const { target } = params as { target: string };
			const activeCoordinator = requireCoordinator();
			const canonical = activeCoordinator.resolve(callerPath, target);
			if (!canonical) throw new Error(`No agent matches "${target}"`);
			const previous = await activeCoordinator.interrupt(callerPath, canonical);
			return {
				content: [
					{
						type: "text" as const,
						text: `Interrupted ${canonical}. Continue it with ${AGENT_TOOLS.followupTask}.`,
					},
				],
				details: { result: { id: canonical, status: previous } },
			};
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.listAgents,
		label: "List Agents",
		description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
		...listAgentsPresentation,
		parameters: Type.Object(
			{
				path_prefix: Type.Optional(
					Type.String({
						description: "Task-path prefix filter without a trailing slash. Omit to list all live agents.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id: string, params: unknown) {
			const { path_prefix } = params as { path_prefix?: string };
			if (path_prefix?.endsWith("/")) throw new Error("path_prefix must not end with /");
			const agents = requireCoordinator()
				.snapshot()
				.filter((agent) => !path_prefix || agent.id.startsWith(path_prefix))
				.map((agent) => ({
					id: agent.id,
					description: agent.description,
					status: agent.status,
					result: agent.result,
					error: agent.error,
				}));
			return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }], details: { agents } };
		},
	});

	registerCollaborationTool({
		name: AGENT_TOOLS.waitAgent,
		label: "Wait For Agent",
		description:
			"Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
		...createWaitToolPresentation(() => {
			const live = otherLiveAgents();
			return live?.length === 1 ? live[0]?.id : undefined;
		}),
		parameters: Type.Object(
			{
				timeout_ms: Type.Optional(
					Type.Number({
						minimum: MIN_WAIT_TIMEOUT_MS,
						maximum: MAX_WAIT_TIMEOUT_MS,
						description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id: string, params: unknown, signal: AbortSignal | undefined) {
			const activeCoordinator = requireCoordinator();
			const startedAt = Date.now();
			if (!otherLiveAgents()?.length)
				return {
					content: [{ type: "text" as const, text: "No other live agents are available for mailbox updates." }],
					details: { wait: { durationMs: 0, outcome: "none" as const } },
				};
			const update = await activeCoordinator.waitForUpdate(
				signal,
				waitTimeout((params as { timeout_ms?: number }).timeout_ms),
			);
			const text = signal?.aborted
				? "The mailbox wait ended because new input interrupted the active turn."
				: !update
					? "No agent updates arrived before the timeout."
					: update.type === "message"
						? `Mailbox update from ${update.sender}.`
						: update.type === "settled" || update.type === "interrupted"
							? `Agent update: ${update.agent.id} (${update.agent.status}).`
							: "Agent transcript updated.";
			const target =
				update?.type === "message"
					? update.sender
					: update?.type === "settled" || update?.type === "interrupted"
						? update.agent.id
						: undefined;
			const outcome: "aborted" | "updated" | "timeout" = signal?.aborted
				? "aborted"
				: update
					? "updated"
					: "timeout";
			return {
				content: [{ type: "text" as const, text }],
				details: { wait: { target, durationMs: Date.now() - startedAt, outcome } },
			};
		},
	});
}
