import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getModelRoleCatalog } from "pi-model-roles/sdk";
import { getSubagentConfig, registerSubagentSettings } from "./config/settings.ts";
import { findRetryableError } from "./runtime/agent-runner.ts";
import {
	type CoordinatorUpdate,
	createRootCoordinator,
	getCoordinatorForSession,
	latestSubagentTreeCheckpoint,
	removeRootCoordinator,
	SUBAGENT_STATE_ENTRY_TYPE,
	type SubagentCoordinator,
} from "./runtime/coordinator.ts";
import { createFollowupTaskTool } from "./tools/followup-task/definition.ts";
import { createInterruptAgentTool } from "./tools/interrupt-agent/definition.ts";
import { createListAgentsTool } from "./tools/list-agents/definition.ts";
import { createRepeatBreaker, withRepeatBreaker } from "./tools/repeat-breaker.ts";
import { createSendMessageTool } from "./tools/send-message/definition.ts";
import type { CollaborationToolScope } from "./tools/scope.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent/definition.ts";
import { createWaitAgentTool } from "./tools/wait-agent/definition.ts";

const RETRY_MESSAGE_TYPE = "retry-failed-request";
const SUBAGENT_MESSAGE_TYPE = "subagent-message";

function rootAgentContext(maxConcurrency: number, maxDepth: number): string {
	return `<root_agent_context>\nYou are /root, the primary agent in one root-scoped agent tree.\nThere are ${maxConcurrency} concurrent agent slots including you.\nSubagent nesting is limited to depth ${maxDepth}.\nUse collaboration tools only for concrete independent work.\n</root_agent_context>`;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	let config = getSubagentConfig();
	let unregisterSettings: (() => void) | undefined;
	let coordinator: SubagentCoordinator | undefined;
	let callerPath: string | undefined;
	let rootSessionId: string | undefined;
	let ownsRoot = false;
	let rootTurnActive = false;
	let unsubscribeCoordinator: (() => void) | undefined;
	const persistedStates = new Map<string, string>();

	const requireCoordinator = (): SubagentCoordinator => {
		if (!coordinator) throw new Error("Subagent coordinator is unavailable for this session");
		return coordinator;
	};
	const liveAgents = () =>
		coordinator
			?.snapshot()
			.filter(
				(agent) => (agent.status === "queued" || agent.status === "running") && agent.id !== (callerPath ?? "/root"),
			) ?? [];
	const scope: CollaborationToolScope = {
		pi,
		coordinator: requireCoordinator,
		callerPath: () => callerPath,
		modelRoles: getModelRoleCatalog,
		otherLiveAgents: liveAgents,
	};

	registerTools(pi, scope);

	const deliverRootMessages = (): void => {
		if (!ownsRoot || !coordinator) return;
		for (const message of coordinator.drainRootMessages()) {
			pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_TYPE,
					content: `Message Type: MESSAGE\nTask name: /root\nSender: ${message.sender}\nPayload:\n${message.message}`,
					display: false,
					details: message,
				},
				{ deliverAs: rootTurnActive ? "steer" : "nextTurn", triggerTurn: false },
			);
		}
	};
	const persistAgentState = (id: string, force = false): void => {
		if (!ownsRoot || !coordinator) return;
		const agent = coordinator.persistedAgent(id);
		if (!agent) return;
		const serialized = JSON.stringify(agent);
		if (!force && persistedStates.get(id) === serialized) return;
		pi.appendEntry(SUBAGENT_STATE_ENTRY_TYPE, { version: 1, agent });
		persistedStates.set(id, serialized);
	};
	const persistAllAgentStates = (force = false): void => {
		for (const agent of coordinator?.checkpoint().agents ?? []) persistAgentState(agent.id, force);
	};
	const routeCoordinatorUpdate = (event: CoordinatorUpdate): void => {
		if (
			event.type === "spawned" ||
			event.type === "started" ||
			event.type === "checkpoint" ||
			event.type === "settled" ||
			event.type === "interrupted"
		) {
			persistAgentState(event.agent.id);
		}
		if (event.type === "message" && event.target === "/root") deliverRootMessages();
	};
	const attachRootRuntime = (): void => {
		if (!coordinator) return;
		ownsRoot = true;
		unsubscribeCoordinator = coordinator.subscribe(routeCoordinatorUpdate);
	};
	const detachRootRuntime = (): void => {
		unsubscribeCoordinator?.();
		unsubscribeCoordinator = undefined;
	};
	const registerRootSettings = (): void => {
		if (unregisterSettings) return;
		unregisterSettings = registerSubagentSettings(() => {
			config = getSubagentConfig();
		});
		config = getSubagentConfig();
	};
	const restoreRootCoordinator = (context: ExtensionContext): void => {
		const sessionId = context.sessionManager.getSessionId();
		const checkpoint = latestSubagentTreeCheckpoint(context.sessionManager.getBranch());
		coordinator = createRootCoordinator(sessionId, {
			...config,
			rootSessionDir: context.sessionManager.getSessionDir(),
		});
		rootSessionId = sessionId;
		callerPath = undefined;
		if (checkpoint) coordinator.restore(checkpoint, { pi, ctx: context });
		persistedStates.clear();
		for (const agent of checkpoint?.agents ?? []) persistedStates.set(agent.id, JSON.stringify(agent));
		attachRootRuntime();
	};

	pi.on("before_agent_start", (event) => {
		if (!ownsRoot || event.systemPrompt.includes("<root_agent_context>")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${rootAgentContext(config.maxConcurrency, config.maxDepth)}` };
	});
	pi.on("session_start", (_event, context) => {
		const sessionId = context.sessionManager.getSessionId();
		const existing = getCoordinatorForSession(sessionId);
		if (existing) {
			coordinator = existing;
			rootSessionId = existing.rootSessionId;
			callerPath = existing.pathForSession(sessionId);
			if (sessionId === existing.rootSessionId) {
				registerRootSettings();
				if (liveAgents().length === 0) {
					removeRootCoordinator(existing.rootSessionId);
					restoreRootCoordinator(context);
				} else {
					attachRootRuntime();
				}
			}
			return;
		}
		registerRootSettings();
		restoreRootCoordinator(context);
	});
	pi.on("agent_start", () => {
		if (ownsRoot) rootTurnActive = true;
		deliverRootMessages();
	});
	pi.on("agent_end", () => {
		if (ownsRoot) rootTurnActive = false;
	});
	pi.on("session_compact", () => persistAllAgentStates(true));
	pi.on("session_before_tree", (_event, context) => {
		if (!ownsRoot || liveAgents().length === 0) return;
		context.ui.notify("Wait for or interrupt active subagents before navigating the session tree.", "warning");
		return { cancel: true };
	});
	pi.on("session_tree", (_event, context) => {
		if (!ownsRoot || !rootSessionId) return;
		detachRootRuntime();
		removeRootCoordinator(rootSessionId);
		restoreRootCoordinator(context);
	});
	pi.on("session_shutdown", (event) => {
		persistAllAgentStates(true);
		detachRootRuntime();
		if (ownsRoot && rootSessionId && event.reason !== "reload") removeRootCoordinator(rootSessionId);
		coordinator = undefined;
		callerPath = undefined;
		rootSessionId = undefined;
		ownsRoot = false;
		rootTurnActive = false;
		persistedStates.clear();
		unregisterSettings?.();
		unregisterSettings = undefined;
	});

	pi.registerCommand("retry", {
		description: "Re-issue the failed request: /retry [main|<subagent id>]",
		handler: async (argumentsText: string, context: ExtensionCommandContext) => {
			await context.waitForIdle();
			const target = argumentsText.trim();
			const mainError = findRetryableError(context.sessionManager.getBranch());
			if (!target || target === "main") {
				if (!mainError) {
					context.ui.notify("No failed main-session request to re-issue.", "warning");
					return;
				}
				pi.sendMessage(
					{
						customType: RETRY_MESSAGE_TYPE,
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
			if (!agent || agent.status !== "failed") {
				context.ui.notify(`No failed subagent matches ${JSON.stringify(target)}.`, "warning");
				return;
			}
			await activeCoordinator.followUp(
				callerPath,
				agent.id,
				"Retry the latest failed request without repeating completed work.",
			);
		},
	});
}

function registerTools(pi: ExtensionAPI, scope: CollaborationToolScope): void {
	const breaker = createRepeatBreaker();
	pi.registerTool(withRepeatBreaker(createSpawnAgentTool(scope), breaker));
	pi.registerTool(withRepeatBreaker(createFollowupTaskTool(scope), breaker));
	pi.registerTool(withRepeatBreaker(createSendMessageTool(scope), breaker));
	pi.registerTool(withRepeatBreaker(createInterruptAgentTool(scope), breaker));
	pi.registerTool(withRepeatBreaker(createListAgentsTool(scope), breaker));
	pi.registerTool(withRepeatBreaker(createWaitAgentTool(scope), breaker));
}
