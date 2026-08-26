import type { Component } from "@earendil-works/pi-tui";
import { ComponentStack, icon, type tuiTheme } from "pi-libtui";
import { LiveToolAction, type ToolActionView, ToolTranscript } from "pi-libtui/tool";
import type { FollowupTaskDetails } from "../tools/followup-task/result.ts";
import type { InterruptAgentDetails } from "../tools/interrupt-agent/result.ts";
import type { ListAgentsDetails } from "../tools/list-agents/result.ts";
import type { SendMessageDetails } from "../tools/send-message/result.ts";
import type { SpawnAgentDetails } from "../tools/spawn-agent/result.ts";
import type { WaitAgentDetails } from "../tools/wait-agent/result.ts";
import { agentDisplayName } from "./agent-tree.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];

interface SpawnParams {
	task_name?: string;
	fork_turns?: string;
	model_role?: string;
}

interface ActionContext<Args, State extends object = object> {
	args: Args;
	toolCallId: string;
	invalidate(): void;
	lastComponent?: Component;
	isPartial?: boolean;
	state: State;
}

interface WaitParams {
	timeout_ms?: number;
}

interface WaitState {
	startedAt?: number;
	target?: string;
	presentation?: WaitPresentation;
}

interface ToolResult<Details> {
	details?: Details;
}

function agentName(target: string | undefined): string {
	return agentDisplayName(target) ?? "agents";
}

function transcript(theme: HostTheme, view: ToolActionView): ToolTranscript {
	return new ToolTranscript({ theme, view });
}

function completedAction(theme: HostTheme, verb: string, target: string): ToolTranscript {
	return transcript(theme, {
		verb,
		detail: agentName(target),
		status: "succeeded",
		marker: icon("developer"),
	});
}

function completedActionPresentation<Details>(verb: string, target: (details: Details) => string) {
	return {
		renderShell: "self" as const,
		renderCall() {
			return new ComponentStack();
		},
		renderResult(result: ToolResult<Details>, _options: object, theme: HostTheme, _context: ActionContext<object>) {
			if (!result.details) return transcript(theme, { verb, status: "warning", marker: icon("developer") });
			return completedAction(theme, verb, target(result.details));
		},
	};
}

export const spawnToolPresentation = {
	renderShell: "self" as const,
	renderCall() {
		return new ComponentStack();
	},
	renderResult(
		result: ToolResult<SpawnAgentDetails>,
		_options: object,
		theme: HostTheme,
		context: ActionContext<SpawnParams>,
	) {
		const details = result.details;
		const name = details?.input.taskName ?? context.args.task_name ?? agentName(details?.agent.id);
		if (!details) {
			return transcript(theme, {
				verb: "Spawn agent",
				detail: name,
				status: "warning",
				marker: icon("developer"),
			});
		}
		const role = details.input.modelRole ?? context.args.model_role;
		return transcript(theme, {
			verb: "Spawned agent",
			detail: name,
			status: "succeeded",
			marker: icon("developer"),
			meta: [role ? `role ${role}` : undefined, forkDescription(String(details.input.forkTurns))].filter(
				(value): value is string => value !== undefined,
			),
		});
	},
};

function forkDescription(value: string | undefined): string {
	const mode = value?.trim() || "all";
	if (mode === "all") return "full history";
	if (mode === "none") return "no history";
	return `${mode} recent turns`;
}

export const followupToolPresentation = completedActionPresentation<FollowupTaskDetails>(
	"Followed up with",
	(details) => details.input.target,
);
export const sendMessageToolPresentation = completedActionPresentation<SendMessageDetails>(
	"Sent a message to",
	(details) => details.input.target,
);
export const interruptToolPresentation = completedActionPresentation<InterruptAgentDetails>(
	"Interrupted",
	(details) => details.input.target,
);

export const listAgentsPresentation = {
	renderShell: "self" as const,
	renderCall() {
		return new ComponentStack();
	},
	renderResult(result: ToolResult<ListAgentsDetails>, _options: object, theme: HostTheme) {
		const count = result.details?.agents?.length ?? 0;
		return transcript(theme, {
			verb: "Listed agents",
			status: "succeeded",
			marker: icon("developer"),
			meta: [`${count} agent${count === 1 ? "" : "s"}`],
		});
	},
};

class WaitPresentation implements Component {
	private readonly action: LiveToolAction;

	constructor(theme: HostTheme, requestRender: () => void, target: string | undefined, startedAt: number) {
		this.action = new LiveToolAction({
			theme,
			requestRender,
			view: waitingView(target, startedAt),
		});
	}

	complete(wait: WaitAgentDetails | undefined): void {
		const none = wait?.status === "none";
		this.action.update(
			{
				verb: none ? "No other agents to wait for" : "Waited for agent",
				detail: none ? undefined : agentName(wait?.update?.target),
				status: wait?.status === "aborted" ? "warning" : "succeeded",
				marker: icon("developer"),
				meta: wait ? [`${Math.max(0, Math.round(wait.timing.durationMs / 1000))}s`] : undefined,
			},
			false,
		);
	}

	render(width: number): string[] {
		return this.action.render(width);
	}

	invalidate(): void {
		this.action.invalidate();
	}

	dispose(): void {
		this.action.dispose();
	}
}

function waitingView(target: string | undefined, startedAt: number): ToolActionView {
	return {
		verb: "Waiting for agent",
		detail: agentName(target),
		status: "running",
		marker: icon("developer"),
		meta: [`started ${new Date(startedAt).toISOString()}`],
	};
}

export function createWaitToolPresentation(waitingTarget: () => string | undefined) {
	return {
		renderShell: "self" as const,
		renderCall(_args: WaitParams, theme: HostTheme, context: ActionContext<WaitParams, WaitState>) {
			if (context.isPartial === false) return new ComponentStack();
			context.state.startedAt ??= Date.now();
			context.state.target ??= waitingTarget();
			context.state.presentation ??= new WaitPresentation(
				theme,
				context.invalidate,
				context.state.target,
				context.state.startedAt,
			);
			return context.state.presentation;
		},
		renderResult(
			result: ToolResult<WaitAgentDetails>,
			_options: object,
			_theme: HostTheme,
			context: ActionContext<WaitParams, WaitState>,
		) {
			context.state.presentation?.complete(result.details);
			return context.state.presentation ?? new ComponentStack();
		},
	};
}
