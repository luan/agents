import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { MotionMount } from "pi-libtui";
import { icon, sharedMotionScheduler, tuiTheme } from "pi-libtui";
import type { AgentHubSnapshot, AgentHubSnapshotSource } from "./agent-browser.ts";
import {
	formatAgentTokens,
	renderAgentMetadata,
	renderAgentStatusMarker,
	renderContextUse,
	renderTranscriptPreview,
} from "./agent-summary.ts";
import { agentDisplayName, agentsWithAncestors, agentTreeRows } from "./agent-tree.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];
type UIContext = ExtensionContext["ui"];

/** Animated summary driven only by immutable coordinator snapshots. */
export class AgentWidget {
	private snapshot: AgentHubSnapshot;
	private uiCtx: UIContext | undefined;
	private motion: MotionMount | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private lastStatus: string | undefined;
	private readonly unsubscribe: () => void;

	constructor(source: AgentHubSnapshotSource) {
		this.snapshot = source.getSnapshot();
		this.unsubscribe = source.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.update();
		});
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
					return { render: (width) => this.render(theme, width), invalidate() {} };
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
		const running = active.filter((agent) => agent.status === "running").length;
		const queued = active.length - running;
		return [
			`${colors.fg("accent", `${icon("developer")} Agents`)} ${colors.fg("text.muted", `· ${running} running${queued ? ` · ${queued} queued` : ""}`)}`,
			...rows.slice(0, 11).map(({ agent, prefix }) => {
				const marker = renderAgentStatusMarker(colors, agent.status, agent.startedAt, now);
				const name = agentDisplayName(agent.id) ?? agent.id;
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
					`${colors.fg("text.muted", prefix)} ${marker} ${colors.fg("accent", name)} ${metadata.join(colors.fg("text.muted", " · "))} ${colors.fg("text.muted", "· ")}${action}`,
					width,
				);
			}),
		];
	}

	private syncMotion(): void {
		if (this.tui && !this.motion) this.motion = sharedMotionScheduler.mount(this.tui, { cadenceMs: 120 });
	}

	private clear(): void {
		this.motion?.dispose();
		this.motion = undefined;
		this.tui = undefined;
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("agents", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("subagents", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}

function activeAgents(snapshot: AgentHubSnapshot) {
	return snapshot.agents.filter((agent) => agent.status === "running" || agent.status === "queued");
}
