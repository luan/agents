import { truncateToWidth } from "@earendil-works/pi-tui";
import { type AnimationMount, runningFrame, sharedAnimationRenderScheduler } from "../../../shared/tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, type LifetimeUsage, type SessionLike } from "../usage.js";

const MAX_WIDGET_LINES = 12;
const WIDGET_REFRESH_MS = 120;

const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type UICtx = {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

export interface AgentActivity {
	activeTools: Map<string, string>;
	toolUses: number;
	responseText: string;
	session?: SessionLike;
	turnCount: number;
	maxTurns?: number;
	lifetimeUsage: LifetimeUsage;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
	return `${count} token`;
}

export function formatAgentModelInfo(
	agent: { modelName?: string; thinkingLevel?: string },
	theme: Theme,
): string | undefined {
	const parts = [agent.modelName, agent.thinkingLevel ? `effort ${agent.thinkingLevel}` : undefined].filter(Boolean);
	return parts.length > 0 ? theme.fg("muted", parts.join(" | ")) : undefined;
}

export function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function describeActivity(activeTools: Map<string, string>): string {
	if (activeTools.size === 0) return "thinking";
	const groups = new Map<string, number>();
	for (const toolName of activeTools.values()) {
		const action = TOOL_DISPLAY[toolName] ?? toolName;
		groups.set(action, (groups.get(action) ?? 0) + 1);
	}
	return [...groups.entries()].map(([action, count]) => (count > 1 ? `${action} ${count}` : action)).join(", ");
}

export class AgentWidget {
	private uiCtx: UICtx | undefined;
	private widgetAnimation: AnimationMount | undefined;
	private widgetRegistered = false;
	private tui: any | undefined;
	private lastStatusText: string | undefined;

	constructor(
		private manager: AgentManager,
		private agentActivity: Map<string, AgentActivity>,
		private getExtraAgents: () => AgentRecord[] = () => [],
		private getRootSessionId: () => string | undefined = () => undefined,
	) {}

	setUICtx(ctx: UICtx): void {
		if (ctx === this.uiCtx) return;
		this.widgetAnimation?.dispose();
		this.widgetAnimation = undefined;
		if (this.uiCtx && this.widgetRegistered) this.uiCtx.setWidget("agents", undefined);
		if (this.uiCtx && this.lastStatusText !== undefined) this.uiCtx.setStatus("subagents", undefined);
		this.uiCtx = ctx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.lastStatusText = undefined;
	}

	private ensureTimer(): void {
		if (this.widgetAnimation || !this.tui) return;
		this.widgetAnimation = sharedAnimationRenderScheduler.mount(this.tui, WIDGET_REFRESH_MS);
	}

	private renderWidget(theme: Theme, width: number, now = Date.now()): string[] {
		const allAgents = this.listAgents();
		const running = allAgents.filter((agent) => agent.status === "running");
		const queued = allAgents.filter((agent) => agent.status === "queued");
		if (running.length === 0 && queued.length === 0) return [];

		const lines = [
			truncateToWidth(
				`${theme.fg("accent", "Agents")} ${theme.fg("dim", `| ${running.length} running${queued.length ? ` | ${queued.length} queued` : ""}`)}`,
				width,
			),
		];
		const visible = running.slice(0, MAX_WIDGET_LINES - 2);
		for (const [index, agent] of visible.entries()) {
			const activity = this.agentActivity.get(agent.id);
			const action = activity ? describeActivity(activity.activeTools) : "thinking";
			const toolUses = activity?.toolUses ?? agent.toolUses;
			const usage = activity?.lifetimeUsage ?? agent.lifetimeUsage;
			const tokens = getLifetimeTotal(usage);
			const stats = [
				agent.modelName ? theme.fg("dim", agent.modelName) : undefined,
				agent.thinkingLevel ? theme.fg("dim", `effort ${agent.thinkingLevel}`) : undefined,
				agent.fastModeActive ? theme.fg("warning", "⚡ fast") : undefined,
				theme.fg("dim", usage.cost > 0 ? `$${usage.cost.toFixed(usage.cost < 0.01 ? 4 : 2)}` : "$0.00"),
				toolUses > 0 ? theme.fg("dim", `${toolUses} tools`) : undefined,
				tokens > 0 ? theme.fg("dim", formatTokens(tokens)) : undefined,
				theme.fg("dim", `${Math.floor((now - agent.startedAt) / 1000)}s`),
			]
				.filter(Boolean)
				.join(theme.fg("dim", " | "));
			const displayId = agent.id.replace(/^\/root\//, "");
			const depth = Math.max(0, displayId.split("/").filter(Boolean).length - 1);
			const connector = index === visible.length - 1 && queued.length === 0 ? "└─" : "├─";
			const spinner = theme.fg("accent", runningFrame(now - agent.startedAt));
			lines.push(
				truncateToWidth(
					`${theme.fg("dim", connector)} ${"  ".repeat(depth)}${spinner} ${theme.fg("accent", displayId)} ${theme.fg("dim", "| ")}${stats}${theme.fg("dim", ` | ${action}`)}`,
					width,
				),
			);
		}
		if (queued.length > 0 && lines.length < MAX_WIDGET_LINES) {
			lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("muted", `${queued.length} queued`)}`, width));
		}
		const hidden = running.length - visible.length;
		if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `   +${hidden} more running`), width));
		return lines;
	}

	update(): void {
		if (!this.uiCtx) return;
		const agents = this.listAgents();
		const runningCount = agents.filter((agent) => agent.status === "running").length;
		const queuedCount = agents.filter((agent) => agent.status === "queued").length;
		const hasActive = runningCount > 0 || queuedCount > 0;

		if (!hasActive) {
			if (this.widgetRegistered) this.uiCtx.setWidget("agents", undefined);
			if (this.lastStatusText !== undefined) this.uiCtx.setStatus("subagents", undefined);
			this.widgetAnimation?.dispose();
			this.widgetAnimation = undefined;
			this.widgetRegistered = false;
			this.tui = undefined;
			this.lastStatusText = undefined;
			return;
		}

		const statusParts = [
			runningCount > 0 ? `${runningCount} running` : undefined,
			queuedCount > 0 ? `${queuedCount} queued` : undefined,
		].filter(Boolean);
		const statusText = `${statusParts.join(", ")} agent${runningCount + queuedCount === 1 ? "" : "s"}`;
		if (statusText !== this.lastStatusText) {
			this.uiCtx.setStatus("subagents", statusText);
			this.lastStatusText = statusText;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"agents",
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		}
		this.ensureTimer();
	}

	dispose(): void {
		this.widgetAnimation?.dispose();
		if (this.uiCtx) {
			if (this.widgetRegistered) this.uiCtx.setWidget("agents", undefined);
			if (this.lastStatusText !== undefined) this.uiCtx.setStatus("subagents", undefined);
		}
		this.widgetRegistered = false;
		this.widgetAnimation = undefined;
		this.tui = undefined;
		this.lastStatusText = undefined;
	}

	private listAgents(): AgentRecord[] {
		const rootSessionId = this.getRootSessionId();
		const byId = new Map<string, AgentRecord>();
		for (const agent of this.manager.listAgents(rootSessionId)) {
			if (agent.isBackground) byId.set(agent.id, agent);
		}
		for (const agent of this.getExtraAgents()) {
			if (!rootSessionId || agent.rootSessionId === rootSessionId) byId.set(agent.id, agent);
		}
		return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
	}
}
