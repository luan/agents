import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSidePanelProvider, type ActivityAnimationOverrides } from "pi-libtui";
import { getModelRoleCatalog } from "pi-model-roles/sdk";
import { getSubagentConfig, registerSubagentSettings } from "./config/settings.ts";
import { registerSubagentActions } from "./contributions/actions.ts";
import { getPresentationResolver } from "./protocol/presentation.ts";
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
import { subagentSessionRoot } from "./runtime/session-root.ts";
import { createFollowupTaskTool } from "./tools/followup-task/definition.ts";
import { createInterruptAgentTool } from "./tools/interrupt-agent/definition.ts";
import { createListAgentsTool } from "./tools/list-agents/definition.ts";
import { createRepeatBreaker, withRepeatBreaker } from "./tools/repeat-breaker.ts";
import type { CollaborationToolScope } from "./tools/scope.ts";
import { createSendMessageTool } from "./tools/send-message/definition.ts";
import { createSpawnAgentTool } from "./tools/spawn-agent/definition.ts";
import { createWaitAgentTool } from "./tools/wait-agent/definition.ts";
import { openAgentHub } from "./ui/agent-browser.ts";
import { AgentHubPresentation } from "./ui/agent-hub-presentation.ts";
import { AgentWidget } from "./ui/agent-widget.ts";
import { CoordinatorSnapshotSource } from "./ui/coordinator-snapshot-source.ts";
import {
	createWaitToolPresentation,
	followupToolPresentation,
	interruptToolPresentation,
	listAgentsPresentation,
	sendMessageToolPresentation,
	spawnToolPresentation,
} from "./ui/tool-presentations.ts";

const RETRY_MESSAGE_TYPE = "retry-failed-request";
const SUBAGENT_MESSAGE_TYPE = "subagent-message";

function rootAgentContext(maxConcurrency: number, maxDepth: number): string {
	return `<root_agent_context>
You are \`/root\`, the primary agent in one root-scoped agent tree.
There are ${maxConcurrency} concurrent agent slots including you.
Subagent nesting is limited to depth ${maxDepth}.
- Use collaboration tools only for concrete independent work.
- Successful child final responses arrive automatically as hidden FINAL_ANSWER mailbox messages to their direct parents. Do not ask children to send their final response with send_message.
- wait_agent is status-only and never carries a child's final response.
- Explicit send_message remains a separate MESSAGE path for interim coordination.
</root_agent_context>`;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	let config = getSubagentConfig();
	let unregisterSettings: (() => void) | undefined;
	let coordinator: SubagentCoordinator | undefined;
	let callerPath: string | undefined;
	let rootSessionId: string | undefined;
	let ownsRoot = false;
	let turnActive = false;
	let source: CoordinatorSnapshotSource | undefined;
	let widget: AgentWidget | undefined;
	let unsubscribeRouting: (() => void) | undefined;
	let unregisterAction: (() => void) | undefined;
	let unregisterSidePanelProvider: (() => void) | undefined;
	let hubPresentation: AgentHubPresentation | undefined;
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

	const localPath = () => callerPath ?? "/root";
	const deliverMailbox = (): void => {
		if (!coordinator) return;
		for (const delivery of coordinator.drainMailbox(localPath())) {
			pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_TYPE,
					content: `Message Type: ${delivery.type}\nTask name: ${delivery.target}\nSender: ${delivery.sender}\nPayload:\n${delivery.payload}`,
					display: false,
					details: delivery,
				},
				{ deliverAs: turnActive ? "steer" : "nextTurn", triggerTurn: false },
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
		if (event.type === "mailbox" && event.delivery.target === localPath()) deliverMailbox();
	};
	const openHub = async (context: Pick<ExtensionContext, "hasUI" | "ui">, initialAgentId?: string): Promise<void> => {
		if (!ownsRoot || !source) return;
		if (!hubPresentation) {
			await openAgentHub(context, source, Date.now, getPresentationResolver, initialAgentId);
			return;
		}
		await hubPresentation.open(context, config.agentHubPresentation, initialAgentId);
	};
	const attachRootPresentation = (context: ExtensionContext): void => {
		if (!coordinator) return;
		ownsRoot = true;
		source = new CoordinatorSnapshotSource(coordinator);
		hubPresentation = new AgentHubPresentation(source, Date.now, getPresentationResolver);
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = registerSidePanelProvider(
			{
				id: "pi-subagents.agent-hub",
				session: context,
				attach(panel) {
					return hubPresentation?.attach(panel);
				},
			},
			globalThis,
		);
		unregisterAction = registerSubagentActions({
			open: openHub,
		});
		if (context.hasUI) {
			widget = new AgentWidget(source, (agentId) => void openHub(context, agentId), agentWidgetAnimation(config));
			widget.setUICtx(context.ui);
		}
	};
	const attachRouting = (): void => {
		unsubscribeRouting?.();
		unsubscribeRouting = coordinator?.subscribe(routeCoordinatorUpdate);
		deliverMailbox();
	};
	const detachRootPresentation = (): void => {
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = undefined;
		hubPresentation?.closeSidePanel();
		hubPresentation = undefined;
		unregisterAction?.();
		unregisterAction = undefined;
		widget?.dispose();
		widget = undefined;
		source?.dispose();
		source = undefined;
	};
	const registerRootSettings = (): void => {
		if (unregisterSettings) return;
		unregisterSettings = registerSubagentSettings(() => {
			config = getSubagentConfig();
			if (config.agentHubPresentation === "fullscreen") hubPresentation?.closeSidePanel();
			widget?.setAnimation(agentWidgetAnimation(config));
		});
		config = getSubagentConfig();
	};
	const restoreRootCoordinator = (context: ExtensionContext): void => {
		const sessionId = context.sessionManager.getSessionId();
		const checkpoint = latestSubagentTreeCheckpoint(context.sessionManager.getBranch());
		coordinator = createRootCoordinator(sessionId, {
			...config,
			rootSessionDir: subagentSessionRoot(context),
		});
		rootSessionId = sessionId;
		callerPath = undefined;
		if (checkpoint) coordinator.restore(checkpoint, { pi, ctx: context });
		persistedStates.clear();
		for (const agent of checkpoint?.agents ?? []) persistedStates.set(agent.id, JSON.stringify(agent));
		attachRootPresentation(context);
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
				attachRootPresentation(context);
			}
			attachRouting();
			return;
		}
		registerRootSettings();
		restoreRootCoordinator(context);
		attachRouting();
	});
	pi.on("agent_start", () => {
		turnActive = true;
		deliverMailbox();
	});
	pi.on("agent_end", () => {
		turnActive = false;
	});
	pi.on("session_compact", () => persistAllAgentStates(true));
	pi.on("session_before_tree", (_event, context) => {
		if (!ownsRoot || liveAgents().length === 0) return;
		context.ui.notify("Wait for or interrupt active subagents before navigating the session tree.", "warning");
		return { cancel: true };
	});
	pi.on("session_tree", (_event, context) => {
		if (!ownsRoot || !rootSessionId) return;
		unsubscribeRouting?.();
		unsubscribeRouting = undefined;
		detachRootPresentation();
		removeRootCoordinator(rootSessionId);
		restoreRootCoordinator(context);
		attachRouting();
	});
	pi.on("session_shutdown", (event) => {
		persistAllAgentStates(true);
		unsubscribeRouting?.();
		unsubscribeRouting = undefined;
		detachRootPresentation();
		if (ownsRoot && rootSessionId && event.reason !== "reload") removeRootCoordinator(rootSessionId);
		coordinator = undefined;
		callerPath = undefined;
		rootSessionId = undefined;
		ownsRoot = false;
		turnActive = false;
		persistedStates.clear();
		unregisterSettings?.();
		unregisterSettings = undefined;
	});

	pi.registerCommand("subagents", {
		description: "Open the Agent Hub",
		handler: async (_arguments, context) => openHub(context),
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

function agentWidgetAnimation(
	config: Pick<ReturnType<typeof getSubagentConfig>, "agentWidgetIndicator">,
): Readonly<ActivityAnimationOverrides> {
	return config.agentWidgetIndicator === "inherit" ? {} : { indicatorStyle: config.agentWidgetIndicator };
}

function registerTools(pi: ExtensionAPI, scope: CollaborationToolScope): void {
	const breaker = createRepeatBreaker();
	pi.registerTool(withRepeatBreaker({ ...createSpawnAgentTool(scope), ...spawnToolPresentation }, breaker));
	pi.registerTool(withRepeatBreaker({ ...createFollowupTaskTool(scope), ...followupToolPresentation }, breaker));
	pi.registerTool(withRepeatBreaker({ ...createSendMessageTool(scope), ...sendMessageToolPresentation }, breaker));
	pi.registerTool(withRepeatBreaker({ ...createInterruptAgentTool(scope), ...interruptToolPresentation }, breaker));
	pi.registerTool(withRepeatBreaker({ ...createListAgentsTool(scope), ...listAgentsPresentation }, breaker));
	pi.registerTool(
		withRepeatBreaker(
			{ ...createWaitAgentTool(scope), ...createWaitToolPresentation(() => scope.otherLiveAgents()[0]?.id) },
			breaker,
		),
	);
}
