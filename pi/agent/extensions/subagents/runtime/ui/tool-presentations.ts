import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type AnimationMount, runningFrame, sharedAnimationRenderScheduler } from "../../../shared/tui/animation.ts";
import { styledSymbol, textComponent } from "../../../shared/tui/card.ts";
import { EmptyComponent } from "../../../shared/tui/components.ts";
import { faint, italic } from "../../../shared/tui/text.ts";
import type { SubagentStatus } from "../coordinator.js";
import { agentDisplayName } from "./agent-tree.js";

type ToolTheme = ExtensionContext["ui"]["theme"];
type TaskPresentationResult = {
	status: SubagentStatus;
	id?: string;
	model_role?: string;
	model_role_color?: string;
	error?: string;
};
type SpawnParams = { task_name?: string; fork_turns?: string; model_role?: string };
type ActionContext<TArgs = Record<string, unknown>, TState = Record<string, unknown>> = {
	args: TArgs;
	toolCallId: string;
	invalidate(): void;
	lastComponent?: Component;
	state: TState;
};
type WaitParams = { timeout_ms?: number };
type WaitResult = {
	target?: string;
	durationMs: number;
	outcome: "aborted" | "none" | "timeout" | "updated";
};
type WaitState = {
	startedAt?: number;
	target?: string;
	done?: boolean;
	durationMs?: number;
	outcome?: WaitResult["outcome"];
	animation?: AnimationMount;
};

const EMPTY_ACTION = new EmptyComponent();

function agentName(target: string | undefined): string {
	return agentDisplayName(target) ?? "agents";
}

function actionLine(theme: ToolTheme, action: string, target?: string): string {
	const targetText = target ? ` ${theme.fg("toolTitle", faint(italic(agentName(target))))}` : "";
	return `${theme.fg("accent", "󰯉")} ${theme.fg("toolTitle", action)}${targetText}${theme.fg("toolTitle", ".")}`;
}

function completedActionPresentation(action: string) {
	return {
		renderShell: "self" as const,
		renderCall() {
			return EMPTY_ACTION;
		},
		renderResult(_result: unknown, _options: unknown, theme: ToolTheme, context: ActionContext<{ target?: string }>) {
			return textComponent(actionLine(theme, action, context.args.target));
		},
	};
}

export const spawnToolPresentation = {
	renderShell: "self" as const,
	renderCall() {
		return EMPTY_ACTION;
	},
	renderResult(
		result: { details?: { result?: TaskPresentationResult } },
		_options: unknown,
		theme: ToolTheme,
		context: ActionContext<SpawnParams>,
	) {
		const item = result.details?.result;
		const params = context.args;
		const name = params.task_name ?? agentName(item?.id);
		if (item?.status === "failed" || item?.error) {
			return textComponent(
				`${styledSymbol(theme, "status.error", "error")} ${theme.fg("error", "Failed to spawn agent")} ${theme.fg("error", faint(italic(name)))}${item.error ? ` ${theme.fg("muted", item.error)}` : ""}`,
			);
		}
		const role = item?.model_role ?? params.model_role;
		const roleColor = item?.model_role_color as Parameters<ToolTheme["fg"]>[0] | undefined;
		const roleText = role ? `${theme.fg("toolTitle", " with role ")}${theme.fg(roleColor ?? "accent", role)}` : "";
		return textComponent(
			`${theme.fg("accent", "󰯉")} ${theme.fg("toolTitle", "Spawned agent ")}${theme.fg("toolTitle", faint(italic(name)))}${roleText} ${forkIcon(theme, params.fork_turns)}`,
		);
	},
};

function forkIcon(theme: ToolTheme, value: string | undefined): string {
	const mode = value?.trim() || "all";
	if (mode === "all") return theme.fg("warning", "󰚾");
	if (mode === "none") return theme.fg("muted", "󰢤");
	return theme.fg("mdLink", "󰁫");
}

export const followupToolPresentation = completedActionPresentation("Followed up with");
export const sendMessageToolPresentation = completedActionPresentation("Sent a message to");
export const interruptToolPresentation = completedActionPresentation("Interrupted");

export const listAgentsPresentation = {
	renderShell: "self" as const,
	renderCall() {
		return EMPTY_ACTION;
	},
	renderResult(result: { details?: { agents?: readonly unknown[] } }, _options: unknown, theme: ToolTheme) {
		const count = result.details?.agents?.length ?? 0;
		return textComponent(
			`${theme.fg("accent", "󰯉")} ${theme.fg("toolTitle", "Listed")} ${theme.fg("muted", String(count))} ${theme.fg("toolTitle", `agent${count === 1 ? "" : "s"}.`)}`,
		);
	},
};

class WaitLine implements Component {
	constructor(
		private readonly theme: ToolTheme,
		private readonly state: WaitState,
	) {}

	render(width: number): string[] {
		const durationMs = this.state.durationMs ?? Date.now() - (this.state.startedAt ?? Date.now());
		const duration = this.theme.fg("muted", `${Math.max(0, Math.round(durationMs / 1000))}s`);
		if (this.state.outcome === "none")
			return [truncateToWidth(actionLine(this.theme, "No other agents to wait for"), width)];
		const target = this.theme.fg("toolTitle", faint(italic(agentName(this.state.target))));
		if (this.state.done) {
			return [
				truncateToWidth(
					`${this.theme.fg("accent", "󰯉")} ${this.theme.fg("toolTitle", "Waited for ")}${target}${this.theme.fg("toolTitle", ".")} ${duration}`,
					width,
				),
			];
		}
		return [
			truncateToWidth(
				`${this.theme.fg("accent", runningFrame(durationMs))} ${this.theme.fg("toolTitle", "Waiting for ")}${target}${this.theme.fg("toolTitle", "…")} ${duration}`,
				width,
			),
		];
	}

	invalidate(): void {}
}

export function createWaitToolPresentation(waitingTarget: () => string | undefined) {
	return {
		renderShell: "self" as const,
		renderCall(_args: unknown, theme: ToolTheme, context: ActionContext<WaitParams, WaitState>) {
			const state = context.state;
			state.startedAt ??= Date.now();
			state.target ??= waitingTarget();
			if (!state.done && !state.animation) {
				state.animation = sharedAnimationRenderScheduler.mount({ requestRender: context.invalidate }, 120);
			}
			return context.lastComponent instanceof WaitLine ? context.lastComponent : new WaitLine(theme, state);
		},
		renderResult(
			result: { details?: { wait?: WaitResult } },
			_options: unknown,
			_theme: ToolTheme,
			context: ActionContext<WaitParams, WaitState>,
		) {
			const state = context.state;
			const wait = result.details?.wait;
			state.done = true;
			state.target = wait?.target ?? state.target;
			state.durationMs = wait?.durationMs ?? Date.now() - (state.startedAt ?? Date.now());
			state.outcome = wait?.outcome;
			state.animation?.dispose();
			state.animation = undefined;
			return EMPTY_ACTION;
		},
	};
}
