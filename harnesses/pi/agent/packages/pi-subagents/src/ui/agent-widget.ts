import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ActivityAnimationOverrides, MotionMount } from "pi-libtui";
import { icon, mountConfiguredAnimation, PointerInteractionController, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { AgentHubAgentSnapshot, AgentHubSnapshot, AgentHubSnapshotSource } from "./agent-browser.ts";
import {
	formatAgentTokens,
	renderAgentIdentity,
	renderAgentMetadata,
	renderContextUse,
	renderTranscriptPreview,
} from "./agent-summary.ts";
import { agentDisplayName, agentsWithAncestors, agentTreeRows } from "./agent-tree.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];
type UIContext = ExtensionContext["ui"];

interface AgentTarget {
	readonly agent: AgentHubAgentSnapshot;
	readonly row: number;
	readonly width: number;
}

/** Animated summary driven only by immutable coordinator snapshots. */
export class AgentWidget {
	private snapshot: AgentHubSnapshot;
	private uiCtx: UIContext | undefined;
	private motion: MotionMount | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private lastStatus: string | undefined;
	private animation: Readonly<ActivityAnimationOverrides>;
	private readonly unsubscribe: () => void;
	private readonly interaction = new PointerInteractionController<AgentTarget>({
		key: ({ agent }) => agent.id,
		rect: ({ row, width }) => ({ x: 0, y: row, width, height: 1 }),
	});

	constructor(
		source: AgentHubSnapshotSource,
		private readonly openAgent: (agentId: string) => void = () => {},
		animation: Readonly<ActivityAnimationOverrides> = {},
	) {
		this.animation = animation;
		this.snapshot = source.getSnapshot();
		this.unsubscribe = source.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.update();
		});
	}

	setAnimation(animation: Readonly<ActivityAnimationOverrides>): void {
		this.animation = animation;
		this.motion?.dispose();
		this.motion = undefined;
		this.syncMotion();
		this.tui?.requestRender();
	}

	setUICtx(ctx: UIContext): void {
		if (ctx === this.uiCtx) return;
		this.clear();
		this.uiCtx = ctx;
		this.update();
	}

	update(): void {
		if (!this.uiCtx) return;
		const active = activeAgents(this.snapshot);
		if (active.length === 0) {
			this.clear();
			return;
		}
		const running = active.filter((agent) => agent.status === "running").length;
		const queued = active.length - running;
		const status = `${running} running${queued ? `, ${queued} queued` : ""} agent${active.length === 1 ? "" : "s"}`;
		if (status !== this.lastStatus) {
			this.uiCtx.setStatus("subagents", status);
			this.lastStatus = status;
		}
		if (!this.registered) {
			this.uiCtx.setWidget(
				"agents",
				(tui, theme) => {
					this.tui = tui;
					this.syncMotion();
					return {
						render: (width) => this.render(theme, width),
						onMouse: (event: TuiMouseEvent) => this.onMouse(event),
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		}
		this.syncMotion();
	}

	dispose(): void {
		this.unsubscribe();
		this.clear();
		this.uiCtx = undefined;
	}

	private render(theme: HostTheme, width: number, now = Date.now()): string[] {
		const colors = tuiTheme(theme);
		const active = activeAgents(this.snapshot);
		const rows = agentTreeRows(
			agentsWithAncestors(this.snapshot.agents, (agent) => agent.status === "running" || agent.status === "queued"),
		);
		const visibleRows = rows.slice(0, 11);
		this.interaction.setTargets(
			visibleRows.map(({ agent }, index) => ({ agent, row: index + 1, width: Math.max(0, width) })),
		);
		const hoveredId = this.interaction.hoveredTarget()?.agent.id;
		const running = active.filter((agent) => agent.status === "running").length;
		const queued = active.length - running;
		return [
			`${colors.fg("accent", `${icon("developer")} Agents`)} ${colors.fg("text.muted", `· ${running} running${queued ? ` · ${queued} queued` : ""}`)}`,
			...visibleRows.map(({ agent, prefix }) => {
				const name = agentDisplayName(agent.id) ?? agent.id;
				const identity = renderAgentIdentity(
					colors,
					name,
					agent.status,
					agent.startedAt,
					now,
					agent.id === hoveredId ? "accent" : "text.primary",
					this.animation,
				);
				const metadata = [
					renderAgentMetadata(colors, agent, now, " · "),
					colors.fg("text.muted", formatAgentTokens(agent.tokenCount)),
					renderContextUse(colors, agent.contextPercent),
					colors.fg("text.muted", `${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}`),
				].filter((value): value is string => value !== undefined);
				const action = agent.activity
					? agent.activity.kind === "compacting"
						? colors.fg("warning", "compacting")
						: colors.fg("info", agent.activity.name)
					: renderTranscriptPreview(colors, agent.transcript.preview());
				return truncateToWidth(
					`${colors.fg("text.muted", prefix)} ${identity} ${metadata.join(colors.fg("text.muted", " · "))} ${colors.fg("text.muted", "· ")}${action}`,
					width,
				);
			}),
		];
	}

	private onMouse(event: TuiMouseEvent): boolean {
		return this.interaction.handleMouse(
			{ ...event, screenCol: event.col, screenRow: event.row },
			{
				onHoverChange: () => this.tui?.requestRender(),
				onActivate: ({ agent }) => this.openAgent(agent.id),
			},
		);
	}

	private syncMotion(): void {
		const running = this.snapshot.agents.some((agent) => agent.status === "running");
		if (this.tui && running && !this.motion) this.motion = mountConfiguredAnimation(this.tui, this.animation);
		if (!running && this.motion) {
			this.motion.dispose();
			this.motion = undefined;
		}
	}

	private clear(): void {
		this.motion?.dispose();
		this.motion = undefined;
		this.tui = undefined;
		this.interaction.clear();
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("agents", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("subagents", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}

function activeAgents(snapshot: AgentHubSnapshot) {
	return snapshot.agents.filter((agent) => agent.status === "running" || agent.status === "queued");
}
