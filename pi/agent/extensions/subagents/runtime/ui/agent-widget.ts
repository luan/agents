import { truncateToWidth } from "@earendil-works/pi-tui";
import { type AnimationMount, sharedAnimationRenderScheduler } from "../../../shared/tui";
import type { AgentHubSnapshot, AgentHubSnapshotSource } from "./agent-browser.js";
import {
	formatAgentTokens,
	renderAgentMetadata,
	renderAgentStatusMarker,
	renderContextUse,
	renderTranscriptPreview,
} from "./agent-summary.js";
import { agentDisplayName, agentsWithAncestors, agentTreeRows } from "./agent-tree.js";

const REFRESH_MS = 120;
export type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type UICtx = {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};
/** Animated summary driven only by immutable coordinator snapshots. */
export class AgentWidget {
	private snapshot: AgentHubSnapshot;
	private uiCtx: UICtx | undefined;
	private animation: AnimationMount | undefined;
	private tui: any;
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
	setUICtx(ctx: UICtx): void {
		if (ctx !== this.uiCtx) {
			this.clear();
			this.uiCtx = ctx;
			this.update();
		}
	}
	update(): void {
		if (!this.uiCtx) return;
		const active = this.snapshot.agents.filter((agent) => agent.status === "running" || agent.status === "queued");
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
					return { render: (width) => this.render(theme, width), invalidate() {} };
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		}
		if (!this.animation && this.tui) this.animation = sharedAnimationRenderScheduler.mount(this.tui, REFRESH_MS);
	}
	dispose(): void {
		this.unsubscribe();
		this.clear();
		this.uiCtx = undefined;
	}
	private render(theme: Theme, width: number, now = Date.now()): string[] {
		const active = this.snapshot.agents.filter((agent) => agent.status === "running" || agent.status === "queued");
		const rows = agentTreeRows(
			agentsWithAncestors(this.snapshot.agents, (agent) => agent.status === "running" || agent.status === "queued"),
		);
		const running = active.filter((agent) => agent.status === "running").length;
		const queued = active.length - running;
		return [
			`${theme.fg("accent", "Agents")} ${theme.fg("dim", `| ${running} running${queued ? ` | ${queued} queued` : ""}`)}`,
			...rows.slice(0, 11).map(({ agent, prefix }) => {
				const marker = renderAgentStatusMarker(theme, agent.status, agent.startedAt, now);
				const name = agentDisplayName(agent.id) ?? agent.id;
				const metadata = [
					renderAgentMetadata(theme, agent, now, " | "),
					theme.fg("muted", formatAgentTokens(agent.tokenCount)),
					renderContextUse(theme, agent.contextPercent),
					theme.fg("muted", `${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}`),
				].filter(Boolean);
				const action = agent.activity
					? agent.activity.kind === "compacting"
						? theme.fg("warning", "compacting")
						: theme.fg("mdLink", agent.activity.name)
					: renderTranscriptPreview(theme, agent.transcript.preview());
				return truncateToWidth(
					`${theme.fg("dim", prefix)} ${marker} ${theme.fg("accent", name)} ${metadata.join(theme.fg("dim", " | "))} ${theme.fg("dim", "| ")}${action}`,
					width,
				);
			}),
		];
	}
	private clear(): void {
		this.animation?.dispose();
		this.animation = undefined;
		this.tui = undefined;
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("agents", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("subagents", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}
