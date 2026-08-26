import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	type ExtensionContext,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MotionMount } from "pi-libtui";
import {
	applyScrollbar,
	FullscreenOverlay,
	fullscreenOverlayOptions,
	mountConfiguredAnimation,
	SelectableList,
	stripTopLevelZoneMarkers,
	tuiTheme,
} from "pi-libtui";
import type { SubagentSnapshot, TranscriptSource } from "../runtime/coordinator.ts";
import type { AgentPresentationResolverLookup } from "../protocol/presentation.ts";
import { renderAgentIdentity, renderAgentMetadata } from "./agent-summary.ts";
import { type AgentTreeRow, agentDisplayName, agentTreeRows } from "./agent-tree.ts";
import type { AgentCustomMessageRendererResolver, AgentToolRendererResolver } from "../protocol/presentation.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];
export type AgentHubAgentSnapshot = SubagentSnapshot & { readonly transcript: TranscriptSource };
export interface AgentHubSnapshot {
	readonly generation: number;
	readonly agents: readonly AgentHubAgentSnapshot[];
}
export interface AgentHubSnapshotSource {
	getSnapshot(): AgentHubSnapshot;
	subscribe(notify: (snapshot: AgentHubSnapshot) => void): () => void;
}

interface CachedBlock {
	lines: string[];
}
type ToolCallPart = Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
interface LiveTool {
	component: ToolExecutionComponent;
	name: string;
	argsKey: string;
	result?: ToolResult;
}

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
				.filter((message): message is ToolResult => message.role === "toolResult")
				.map((message) => [message.toolCallId, message]),
		);
		const lastRenderableIndex = findLastRenderableMessage(messages);
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
					const identity = result ? `tool:${part.id}:${result.timestamp}:${result.isError}` : `tool:${part.id}:pending`;
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
		return stripTopLevelZoneMarkers(lines);
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
			const cache = this.settled.get(identity) ?? new Map<string, CachedBlock>();
			cache.set(cacheKey, { lines });
			this.settled.set(identity, cache);
		}
		return lines;
	}

	private renderMessage(message: Exclude<AgentMessage, { role: "assistant" | "toolResult" }>, width: number): string[] {
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
			if (!skill) return new UserMessageComponent(text).render(width);
			const lines = new SkillInvocationMessageComponent(skill).render(width);
			if (skill.userMessage) lines.push(...new UserMessageComponent(skill.userMessage).render(width));
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

/** Read-only full-screen Agent Hub backed by immutable coordinator snapshots. */
export class AgentHub {
	focused = true;
	private snapshot: AgentHubSnapshot;
	private selectedId: string | undefined;
	private offset = 0;
	private followTail = true;
	private pendingTopKey = false;
	private closed = false;
	private bodyRows = 1;
	private listWidth = 0;
	private detailStart = 0;
	private readonly unsubscribe: () => void;
	private transcriptUnsubscribe: (() => void) | undefined;
	private motion: MotionMount | undefined;
	private readonly renderers = new Map<string, AgentTranscriptRenderer>();
	private readonly list: SelectableList<AgentTreeRow<AgentHubAgentSnapshot>>;

	constructor(
		source: AgentHubSnapshotSource,
		private readonly tui: TUI,
		private readonly theme: HostTheme,
		private readonly done: () => void,
		private readonly resolvePresentation: AgentPresentationResolverLookup = () => undefined,
	) {
		this.snapshot = source.getSnapshot();
		this.selectedId = this.snapshot.agents[0]?.id;
		this.list = new SelectableList({
			items: agentTreeRows(this.snapshot.agents),
			wrap: false,
			activateOnClick: false,
			requestRender: () => this.tui.requestRender(),
			onSelectionChange: ({ agent }) => this.selectAgent(agent.id),
			onActivate: ({ agent }) => this.selectAgent(agent.id),
			renderItem: (row, context) => this.agentRow(row, context.selected || context.hovered, Date.now()),
		});
		this.bindTranscript();
		this.unsubscribe = source.subscribe((snapshot) => {
			const previousSelection = this.selectedId;
			this.snapshot = snapshot;
			if (!snapshot.agents.some((agent) => agent.id === this.selectedId)) this.selectedId = snapshot.agents[0]?.id;
			const rows = agentTreeRows(snapshot.agents);
			this.list.setItems(
				rows,
				Math.max(
					0,
					rows.findIndex(({ agent }) => agent.id === this.selectedId),
				),
			);
			if (previousSelection !== this.selectedId) this.bindTranscript();
			this.syncMotion();
		});
		this.syncMotion();
	}

	onMouse(event: Parameters<SelectableList<AgentTreeRow<AgentHubAgentSnapshot>>["onMouse"]>[0]): boolean {
		const bodyRow = event.row - 3;
		if (bodyRow < 0 || bodyRow >= this.bodyRows) return false;
		if (this.listWidth > 0 && event.col < this.listWidth) return this.list.onMouse({ ...event, row: bodyRow });
		if (event.type !== "wheel" || event.wheel === undefined || event.col < this.detailStart) return false;
		this.scroll(event.wheel * 3);
		this.tui.requestRender();
		return true;
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
		if (this.list.handleInput(data)) return;
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.scroll(-10);
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
		const colors = tuiTheme(this.theme);
		const bodyRows = Math.max(1, this.tui.terminal.rows - 7);
		const listWidth = width >= 76 ? Math.max(34, Math.floor(width * 0.42)) : 0;
		this.bodyRows = bodyRows;
		this.listWidth = listWidth;
		this.detailStart = listWidth ? listWidth + 3 : 0;
		const agent = this.snapshot.agents.find((candidate) => candidate.id === this.selectedId);
		const detailWidth = listWidth ? width - listWidth - 3 : width;
		const detail = agent ? this.transcript(agent, detailWidth) : [colors.fg("text.muted", "No agents.")];
		const maxOffset = Math.max(0, detail.length - bodyRows);
		this.offset = this.followTail ? maxOffset : Math.min(this.offset, maxOffset);
		const visible = applyScrollbar(detail.slice(this.offset, this.offset + bodyRows), {
			theme: this.theme,
			width: detailWidth,
			height: bodyRows,
			offset: this.offset,
			total: detail.length,
		});
		this.list.setMaxVisible(bodyRows);
		const list = listWidth ? this.list.render(listWidth) : [];
		const running = this.snapshot.agents.filter((item) => item.status === "running").length;
		const queued = this.snapshot.agents.filter((item) => item.status === "queued").length;
		const finished = this.snapshot.agents.length - running - queued;
		const rows = Array.from({ length: bodyRows }, (_, index) => {
			if (!listWidth) return truncateToWidth(visible[index] ?? "", width, "");
			return `${fitLine(list[index] ?? "", listWidth)} ${colors.fg("border", "│")} ${truncateToWidth(visible[index] ?? "", detailWidth, "")}`;
		});
		return [
			colors.fg("heading", this.theme.bold(`Agents · ${this.snapshot.agents.length} current-session`)),
			colors.fg("text.muted", "j/k move · ctrl-u/d scroll · gg/Home top · G/End bottom · alt+a/q/esc close"),
			colors.fg("border", "─".repeat(width)),
			...rows,
			colors.fg("border", "─".repeat(width)),
			colors.fg("text.muted", `${running} running · ${queued} queued · ${finished} finished`),
		];
	}

	invalidate(): void {
		this.list.invalidate();
	}

	dispose(): void {
		this.cleanup();
	}

	private transcript(agent: AgentHubAgentSnapshot, width: number): string[] {
		if (!agent.transcriptAvailable) return [tuiTheme(this.theme).fg("text.muted", "Transcript is not available yet.")];
		let renderer = this.renderers.get(agent.id);
		if (!renderer) {
			const presentation = this.resolvePresentation(agent.id);
			renderer = new AgentTranscriptRenderer(
				this.tui,
				agent.cwd,
				presentation?.resolveTool,
				presentation?.resolveCustomMessage,
			);
			this.renderers.set(agent.id, renderer);
		}
		return renderer.render(
			agent.transcript.getMessages(),
			agent.transcript.generation(),
			width,
			agent.status === "running",
		);
	}

	private selectAgent(id: string): void {
		if (this.selectedId === id) return;
		this.selectedId = id;
		this.bindTranscript();
		this.offset = 0;
		this.followTail = true;
	}

	private scroll(delta: number): void {
		this.followTail = false;
		this.offset = Math.max(0, this.offset + delta);
	}

	private agentRow(row: AgentTreeRow<AgentHubAgentSnapshot>, selected: boolean, now: number): string {
		const colors = tuiTheme(this.theme);
		const metadata = renderAgentMetadata(colors, row.agent, now);
		const name = agentDisplayName(row.agent.id) ?? row.agent.id;
		const identity = renderAgentIdentity(
			colors,
			name,
			row.agent.status,
			row.agent.startedAt,
			now,
			selected ? "accent" : "text.primary",
		);
		return `${colors.fg("text.muted", row.prefix)} ${identity} ${colors.fg("text.muted", "·")} ${metadata}`;
	}

	private syncMotion(): void {
		const running = this.snapshot.agents.some((agent) => agent.status === "running");
		if (running && !this.motion) this.motion = mountConfiguredAnimation(this.tui);
		if (!running && this.motion) {
			this.motion.dispose();
			this.motion = undefined;
		}
	}

	private bindTranscript(): void {
		this.transcriptUnsubscribe?.();
		const selected = this.snapshot.agents.find((agent) => agent.id === this.selectedId);
		this.transcriptUnsubscribe = selected?.transcript.subscribe(() => this.tui.requestRender());
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		if (!this.closed) this.closed = true;
		this.unsubscribe();
		this.transcriptUnsubscribe?.();
		this.motion?.dispose();
	}
}

export async function openAgentHub(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	source: AgentHubSnapshotSource,
	resolvePresentation?: AgentPresentationResolverLookup,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => {
			const hub = new AgentHub(source, tui, theme, done, resolvePresentation);
			return new FullscreenOverlay(tui, theme, hub, { label: "Agent Hub", icon: "developer" });
		},
		{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
	);
}

function messageIdentity(message: AgentMessage, index: number): string {
	if (message.role === "toolResult") return `result:${message.toolCallId}`;
	return `${message.role}:${"timestamp" in message ? message.timestamp : 0}:${index}`;
}

function findLastRenderableMessage(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role !== "toolResult") return index;
	}
	return -1;
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
