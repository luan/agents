import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	type ExtensionCommandContext,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type AnimationMount, sharedAnimationRenderScheduler } from "../../../shared/tui/animation.ts";
import {
	FLOATING_HUB_CHROME_ROWS,
	FLOATING_HUB_OVERLAY_OPTIONS,
	floatingHubBold,
	floatingHubBorderBottom,
	floatingHubBorderTop,
	floatingHubHeight,
	floatingHubInnerWidth,
	floatingHubRow,
	floatingHubSeparator,
} from "../../../shared/tui/floating-hub.ts";
import { padToVisibleWidth, paintHalfHeightBackgroundEdges } from "../../../shared/tui/text.ts";
import type { SubagentSnapshot, TranscriptSource } from "../coordinator.js";
import { renderAgentMetadata, renderAgentStatusMarker } from "./agent-summary.js";
import { agentDisplayName, agentTreeRows } from "./agent-tree.js";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };
export type AgentHubAgentSnapshot = SubagentSnapshot & { readonly transcript: TranscriptSource };
export type AgentHubSnapshot = { readonly generation: number; readonly agents: readonly AgentHubAgentSnapshot[] };
export type AgentHubSnapshotSource = {
	getSnapshot(): AgentHubSnapshot;
	subscribe(notify: (snapshot: AgentHubSnapshot) => void): () => void;
};
export type AgentToolRendererResolver = (name: string) => ToolDefinition<any, any> | undefined;
export type AgentCustomMessageRendererResolver = (
	customType: string,
) => ConstructorParameters<typeof CustomMessageComponent>[1];

type CachedBlock = { lines: string[] };
type ToolCallPart = Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type LiveTool = {
	component: ToolExecutionComponent;
	name: string;
	argsKey: string;
	result?: ToolResult;
};

/** Presentation-only Pi transcript renderer. It never executes a tool. */
export class AgentTranscriptRenderer {
	private readonly settled = new Map<string, Map<string, CachedBlock>>();
	private readonly tools = new Map<string, LiveTool>();
	private generation = -1;
	constructor(
		private readonly tui: TUI,
		private readonly cwd: string,
		private readonly resolveTool: AgentToolRendererResolver = () => undefined,
		private readonly resolveCustomMessage: AgentCustomMessageRendererResolver = () => undefined,
	) {}

	render(messages: readonly AgentMessage[], generation: number, width: number, streaming: boolean): string[] {
		if (generation !== this.generation) {
			this.settled.clear();
			this.tools.clear();
			this.generation = generation;
		}
		const results = new Map(
			messages
				.filter(
					(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
				)
				.map((message) => [message.toolCallId, message]),
		);
		const lastRenderableIndex = messages.findLastIndex((message) => message.role !== "toolResult");
		const lines: string[] = [];
		for (const [index, message] of messages.entries()) {
			if (message.role === "toolResult") continue;
			const liveTail = streaming && index === lastRenderableIndex;
			if (message.role === "assistant") {
				lines.push(
					...this.renderCached(messageIdentity(message, index), generation, width, liveTail, () =>
						this.renderAssistantMessage(message, width, liveTail),
					),
				);
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const result = results.get(part.id);
					const identity = result
						? `tool:${part.id}:${result.timestamp}:${result.isError}`
						: `tool:${part.id}:pending`;
					lines.push(
						...this.renderCached(identity, generation, width, liveTail && !result, () =>
							this.renderTool(part, result, width),
						),
					);
				}
				continue;
			}
			lines.push(
				...this.renderCached(messageIdentity(message, index), generation, width, liveTail, () =>
					this.renderMessage(message, width),
				),
			);
		}
		return lines;
	}
	private renderCached(
		identity: string,
		generation: number,
		width: number,
		live: boolean,
		render: () => string[],
	): string[] {
		const cacheKey = `${generation}:${width}`;
		const cached = this.settled.get(identity)?.get(cacheKey);
		if (!live && cached) return cached.lines;
		const lines = render();
		if (!live) {
			let cache = this.settled.get(identity);
			if (!cache) {
				cache = new Map();
				this.settled.set(identity, cache);
			}
			cache.set(cacheKey, { lines });
		}
		return lines;
	}

	private renderMessage(message: AgentMessage, width: number): string[] {
		if (message.role === "bashExecution") {
			const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
			if (message.output) component.appendOutput(message.output);
			component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
			return component.render(width);
		}
		if (message.role === "custom") {
			if (!message.display) return [];
			return new CustomMessageComponent(message, this.resolveCustomMessage(message.customType), undefined, 0).render(
				width,
			);
		}
		if (message.role === "compactionSummary") return new CompactionSummaryMessageComponent(message).render(width);
		if (message.role === "branchSummary") return new BranchSummaryMessageComponent(message).render(width);
		if (message.role === "user") {
			const text = textOf(message.content);
			const skill = parseSkillBlock(text);
			if (!skill) return paintHalfHeightBackgroundEdges(new UserMessageComponent(text).render(width), width);
			const lines = paintHalfHeightBackgroundEdges(new SkillInvocationMessageComponent(skill).render(width), width);
			if (skill.userMessage) {
				lines.push(
					...paintHalfHeightBackgroundEdges(new UserMessageComponent(skill.userMessage).render(width), width),
				);
			}
			return lines;
		}
		return [];
	}
	private renderAssistantMessage(
		message: Extract<AgentMessage, { role: "assistant" }>,
		width: number,
		streaming: boolean,
	): string[] {
		const component = new AssistantMessageComponent(message, false, undefined, undefined, 0);
		component.updateContent(message, streaming);
		return component.render(width);
	}
	private renderTool(part: ToolCallPart, result: ToolResult | undefined, width: number): string[] {
		const argsKey = JSON.stringify(part.arguments);
		let live = this.tools.get(part.id);
		if (!live || live.name !== part.name) {
			const component = new ToolExecutionComponent(
				part.name,
				part.id,
				part.arguments,
				{ showImages: false },
				this.resolveTool(part.name),
				this.tui,
				this.cwd,
			);
			component.markExecutionStarted();
			component.setArgsComplete();
			live = { component, name: part.name, argsKey };
			this.tools.set(part.id, live);
		} else if (live.argsKey !== argsKey) {
			live.component.updateArgs(part.arguments);
			live.component.setArgsComplete();
			live.argsKey = argsKey;
		}
		if (result && live.result !== result) {
			live.component.updateResult(
				{ content: result.content as never, details: result.details, isError: result.isError },
				false,
			);
			live.result = result;
		}
		return live.component.render(width);
	}
}

/** Read-only Agent Hub backed by immutable coordinator snapshots. */
export class AgentHub {
	focused = true;
	private snapshot: AgentHubSnapshot;
	private selectedId: string | undefined;
	private offset = 0;
	private followTail = true;
	private pendingTopKey = false;
	private readonly unsubscribe: () => void;
	private transcriptUnsubscribe: (() => void) | undefined;
	private animation: AnimationMount | undefined;
	private readonly renderers = new Map<string, AgentTranscriptRenderer>();
	constructor(
		source: AgentHubSnapshotSource,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly resolveTool: AgentToolRendererResolver = () => undefined,
		private readonly resolveCustomMessage: AgentCustomMessageRendererResolver = () => undefined,
	) {
		this.snapshot = source.getSnapshot();
		this.selectedId = this.snapshot.agents[0]?.id;
		this.bindTranscript();
		this.unsubscribe = source.subscribe((snapshot) => {
			const previous = this.selectedId;
			this.snapshot = snapshot;
			if (!snapshot.agents.some((agent) => agent.id === this.selectedId)) this.selectedId = snapshot.agents[0]?.id;
			if (previous !== this.selectedId) this.bindTranscript();
			this.syncAnimation();
			this.tui.requestRender();
		});
		this.syncAnimation();
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("a")) || data === "q") {
			this.close();
			return;
		}
		if (data === "g") {
			if (this.pendingTopKey) {
				this.followTail = false;
				this.offset = 0;
			}
			this.pendingTopKey = !this.pendingTopKey;
			this.tui.requestRender();
			return;
		}
		this.pendingTopKey = false;
		if (matchesKey(data, Key.up) || data === "k") this.select(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.select(1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.scroll(-10);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) this.scroll(10);
		else if (data === "G" || matchesKey(data, Key.end)) this.followTail = true;
		else if (matchesKey(data, Key.home)) {
			this.followTail = false;
			this.offset = 0;
		}
		this.tui.requestRender();
	}
	render(width: number): string[] {
		if (width < 8) return [];
		const innerWidth = floatingHubInnerWidth(width);
		const bodyRows = Math.max(1, floatingHubHeight(this.tui.terminal.rows) - FLOATING_HUB_CHROME_ROWS);
		const listWidth = innerWidth >= 76 ? Math.max(36, Math.floor(innerWidth * 0.48)) : 0;
		const agent = this.snapshot.agents.find((candidate) => candidate.id === this.selectedId);
		const detailWidth = listWidth ? innerWidth - listWidth - 3 : innerWidth;
		const detail = agent ? this.transcript(agent, detailWidth) : [this.theme.fg("muted", "No agents.")];
		const maxOffset = Math.max(0, detail.length - bodyRows);
		this.offset = this.followTail ? maxOffset : Math.min(this.offset, maxOffset);
		const visible = detail.slice(this.offset, this.offset + bodyRows);
		const tree = agentTreeRows(this.snapshot.agents);
		const selectedIndex = Math.max(
			0,
			tree.findIndex(({ agent: item }) => item.id === this.selectedId),
		);
		const listOffset = Math.max(0, Math.min(selectedIndex, selectedIndex - bodyRows + 1));
		const now = Date.now();
		const list = tree
			.slice(listOffset, listOffset + bodyRows)
			.map(({ agent: item, prefix }) =>
				truncateToWidth(this.agentRow(item, prefix, item.id === this.selectedId, now), listWidth, "…"),
			);
		const running = this.snapshot.agents.filter((item) => item.status === "running").length;
		const queued = this.snapshot.agents.filter((item) => item.status === "queued").length;
		const finished = this.snapshot.agents.length - running - queued;
		const body = Array.from({ length: bodyRows }, (_, index) => {
			if (!listWidth) return floatingHubRow(this.theme, visible[index] ?? "", innerWidth);
			const content = `${padToVisibleWidth(list[index] ?? "", listWidth, { truncate: false })} ${this.theme.fg("border", "│")} ${visible[index] ?? ""}`;
			return floatingHubRow(this.theme, content, innerWidth);
		});
		return [
			floatingHubBorderTop(this.theme, width),
			floatingHubRow(
				this.theme,
				`${floatingHubBold(this.theme, "agents")} ${this.theme.fg("dim", `${this.snapshot.agents.length} current-session`)}`,
				innerWidth,
			),
			floatingHubRow(
				this.theme,
				this.theme.fg("dim", "j/k move · ctrl-u/d scroll · gg/Home top · G/End bottom · alt+a/q/esc close"),
				innerWidth,
			),
			floatingHubSeparator(this.theme, innerWidth),
			...body,
			floatingHubSeparator(this.theme, innerWidth),
			floatingHubRow(
				this.theme,
				this.theme.fg("dim", `${running} running · ${queued} queued · ${finished} finished`),
				innerWidth,
			),
			floatingHubBorderBottom(this.theme, width),
		];
	}
	invalidate(): void {
		this.renderers.clear();
	}
	dispose(): void {
		this.unsubscribe();
		this.transcriptUnsubscribe?.();
		this.animation?.dispose();
	}
	private transcript(agent: AgentHubAgentSnapshot, width: number): string[] {
		if (!agent.transcriptAvailable) return [this.theme.fg("muted", "Transcript is not available yet.")];
		let renderer = this.renderers.get(agent.id);
		if (!renderer) {
			renderer = new AgentTranscriptRenderer(this.tui, agent.cwd, this.resolveTool, this.resolveCustomMessage);
			this.renderers.set(agent.id, renderer);
		}
		return renderer.render(
			agent.transcript.getMessages(),
			agent.transcript.generation(),
			width,
			agent.status === "running",
		);
	}
	private select(delta: number): void {
		const tree = agentTreeRows(this.snapshot.agents);
		const current = tree.findIndex(({ agent }) => agent.id === this.selectedId);
		const next = Math.min(Math.max(0, current + delta), Math.max(0, tree.length - 1));
		this.selectedId = tree[next]?.agent.id;
		this.bindTranscript();
		this.offset = 0;
		this.followTail = true;
	}
	private scroll(delta: number): void {
		this.followTail = false;
		this.offset = Math.max(0, this.offset + delta);
	}
	private close(): void {
		this.unsubscribe();
		this.transcriptUnsubscribe?.();
		this.animation?.dispose();
		this.done();
	}
	private agentRow(agent: AgentHubAgentSnapshot, prefix: string, selected: boolean, now: number): string {
		const marker = renderAgentStatusMarker(this.theme, agent.status, agent.startedAt, now);
		const metadata = renderAgentMetadata(this.theme, agent, now);
		const name = agentDisplayName(agent.id) ?? agent.id;
		const label = this.theme.fg(selected ? "accent" : "text", name);
		return `${selected ? "▸" : " "} ${this.theme.fg("dim", prefix)} ${marker} ${label} ${this.theme.fg("dim", "·")} ${metadata}`;
	}
	private syncAnimation(): void {
		const running = this.snapshot.agents.some((agent) => agent.status === "running");
		if (running && !this.animation) this.animation = sharedAnimationRenderScheduler.mount(this.tui, 120);
		if (!running && this.animation) {
			this.animation.dispose();
			this.animation = undefined;
		}
	}
	private bindTranscript(): void {
		this.transcriptUnsubscribe?.();
		const selected = this.snapshot.agents.find((agent) => agent.id === this.selectedId);
		this.transcriptUnsubscribe = selected?.transcript.subscribe(() => this.tui.requestRender());
	}
}

export async function openAgentHub(
	ctx: ExtensionCommandContext,
	source: AgentHubSnapshotSource,
	resolveTool?: AgentToolRendererResolver,
	resolveCustomMessage?: AgentCustomMessageRendererResolver,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => new AgentHub(source, tui, theme, done, resolveTool, resolveCustomMessage),
		{ overlay: true, overlayOptions: FLOATING_HUB_OVERLAY_OPTIONS },
	);
}

function messageIdentity(message: AgentMessage, index: number): string {
	if (message.role === "toolResult") return `result:${message.toolCallId}`;
	return `${message.role}:${"timestamp" in message ? message.timestamp : 0}:${index}`;
}
function textOf(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}
