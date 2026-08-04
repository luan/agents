import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { formatMs } from "./agent-widget.js";

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type AgentHarnessActions = {
	steer(id: string, message: string): Promise<boolean>;
	stop(id: string): boolean;
	followUp(id: string, prompt: string): Promise<boolean>;
};

type HarnessMode = "browse" | "input";
type DetailTab = "output" | "activity" | "assignment";

const TABS: DetailTab[] = ["output", "activity", "assignment"];
const CHROME_ROWS = 7;

export class AgentHarness {
	focused = true;
	private selectedIndex = 0;
	private listOffset = 0;
	private detailOffset = 0;
	private followTail = true;
	private pendingG = false;
	private detailTotal = 0;
	private detailViewport = 0;
	private lastContentKey = "";
	private lastOutputRevision = "";
	private lastOutputUnits = 0;
	private unreadUpdates = 0;
	private tab: DetailTab = "output";
	private mode: HarnessMode = "browse";
	private inputAction: "steer" | "followUp" = "steer";
	private readonly input = new Input();
	private message = "";
	private readonly unsubscribe: Array<() => void>;
	private closed = false;

	constructor(
		private readonly records: AgentRecord[],
		private readonly actions: AgentHarnessActions,
		private readonly tui: Pick<TUI, "requestRender" | "terminal">,
		private readonly theme: Theme,
		private readonly done: () => void,
		selectedId?: string,
	) {
		const selected = selectedId ? records.findIndex((record) => record.id === selectedId) : -1;
		if (selected >= 0) this.selectedIndex = selected;
		this.input.onSubmit = (value) => void this.submitInput(value);
		this.input.onEscape = () => this.cancelInput();
		this.unsubscribe = records.flatMap((record) =>
			record.session ? [record.session.subscribe(() => this.tui.requestRender())] : [],
		);
		if (records.some((record) => record.status === "queued" || record.status === "running")) {
			const refresh = setInterval(() => {
				this.tui.requestRender();
				if (!records.some((record) => record.status === "queued" || record.status === "running")) {
					clearInterval(refresh);
				}
			}, 250);
			refresh.unref();
			this.unsubscribe.push(() => clearInterval(refresh));
		}
	}

	handleInput(data: string): void {
		if (this.mode === "input") {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		const mouse = data.match(/\x1b\[<(\d+);/);
		if (mouse?.[1] === "64" || mouse?.[1] === "65") {
			this.scrollDetail(mouse[1] === "64" ? -3 : 3);
			return;
		}
		if (data === "g") {
			if (this.pendingG) {
				this.followTail = false;
				this.setDetailOffset(0);
				this.pendingG = false;
			} else {
				this.pendingG = true;
				this.tui.requestRender();
			}
			return;
		}
		this.pendingG = false;
		const single = this.records.length === 1;
		if (matchesKey(data, Key.up) || data === "k") {
			if (single) this.scrollDetail(-1);
			else this.moveSelection(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (single) this.scrollDetail(1);
			else this.moveSelection(1);
		} else if (matchesKey(data, Key.left) || data === "h") this.switchTab(-1);
		else if (matchesKey(data, Key.right) || data === "l" || matchesKey(data, Key.tab)) this.switchTab(1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.scrollDetail(-this.pageSize());
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) this.scrollDetail(this.pageSize());
		else if (matchesKey(data, Key.home)) {
			this.followTail = false;
			this.setDetailOffset(0);
		} else if (data === "G" || matchesKey(data, Key.end)) {
			this.followTail = true;
			this.unreadUpdates = 0;
			this.tui.requestRender();
		} else if (data === "a") {
			this.followTail = !this.followTail;
			if (this.followTail) this.unreadUpdates = 0;
			this.message = "";
			this.tui.requestRender();
		} else if (data === "s") this.startInput("steer");
		else if (data === "f") this.startInput("followUp");
		else if (data === "x") this.stopSelected();
	}

	render(width: number): string[] {
		if (width < 24) return [];
		const innerWidth = width - 4;
		const bodyHeight = Math.max(4, Math.floor(this.tui.terminal.rows * 0.95) - CHROME_ROWS);
		const lines = [
			this.borderTop(width),
			this.row(
				`${this.theme.bold("subagent harness")} ${this.theme.fg("dim", `${this.records.length} agent${this.records.length === 1 ? "" : "s"}`)}`,
				innerWidth,
			),
			this.row(
				this.theme.fg(
					"dim",
					"j/k or wheel move/scroll · gg/G top/bottom · ctrl-u/d page · a auto-scroll · h/l view · s/f message · x stop · q close",
				),
				innerWidth,
			),
			this.separator(innerWidth),
		];
		if (this.records.length === 0) {
			lines.push(this.row(this.theme.fg("muted", "No subagents in this session."), innerWidth));
		} else {
			lines.push(...this.renderBody(innerWidth, bodyHeight));
		}
		lines.push(this.separator(innerWidth));
		lines.push(this.row(this.renderFooter(innerWidth), innerWidth));
		lines.push(this.borderBottom(width));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.cleanup();
	}

	private renderBody(width: number, height: number): string[] {
		const listWidth = this.records.length > 1 && width >= 80 ? Math.max(24, Math.floor(width * 0.3)) : 0;
		if (listWidth === 0) {
			const detail = this.renderDetail(width, height);
			return Array.from({ length: height }, (_, index) => this.row(detail[index] ?? "", width));
		}
		const detailWidth = width - listWidth - 3;
		const list = this.renderList(listWidth, height);
		const detail = this.renderDetail(detailWidth, height);
		return Array.from({ length: height }, (_, index) => {
			const left = pad(list[index] ?? "", listWidth);
			const right = pad(detail[index] ?? "", detailWidth);
			return this.row(`${left} ${this.theme.fg("borderMuted", "│")} ${right}`, width);
		});
	}

	private renderList(width: number, height: number): string[] {
		this.clampSelection();
		if (this.selectedIndex < this.listOffset) this.listOffset = this.selectedIndex;
		if (this.selectedIndex >= this.listOffset + height) this.listOffset = this.selectedIndex - height + 1;
		return this.records.slice(this.listOffset, this.listOffset + height).map((record, visibleIndex) => {
			const selected = visibleIndex + this.listOffset === this.selectedIndex;
			const marker = selected ? this.theme.fg("accent", "▸") : " ";
			const status = statusText(this.theme, record.status);
			const depth = Math.max(0, record.id.split("/").filter(Boolean).length - 1);
			return truncateToWidth(
				`${marker} ${"  ".repeat(depth)}${status} ${selected ? this.theme.fg("accent", record.description) : record.description}`,
				width,
				"…",
			);
		});
	}

	private renderDetail(width: number, height: number): string[] {
		const record = this.selectedRecord();
		if (!record) return [];
		const duration = formatMs((record.completedAt ?? Date.now()) - record.startedAt);
		const usage = getLifetimeTotal(record.lifetimeUsage);
		const header = [
			truncateToWidth(`${this.theme.bold(record.description)} ${this.theme.fg("dim", record.id)}`, width, "…"),
			truncateToWidth(
				`${statusText(this.theme, record.status)} ${this.theme.fg("dim", `· ${record.type}${record.modelName ? ` · ${record.modelName}` : ""}${record.thinkingLevel ? ` · ${record.thinkingLevel}` : ""}`)}`,
				width,
				"…",
			),
			truncateToWidth(
				this.theme.fg(
					"dim",
					`${record.toolUses} tools · ${usage} tokens · ${duration} · parent ${record.parentAgentId ?? "root"}`,
				),
				width,
				"…",
			),
			this.renderTabs(width),
		];
		const viewport = Math.max(1, height - header.length);
		const content = this.detailLines(record, width);
		const contentKey = `${record.id}:${this.tab}`;
		const output = outputState(record);
		if (contentKey !== this.lastContentKey) {
			this.lastContentKey = contentKey;
			this.lastOutputRevision = output.revision;
			this.lastOutputUnits = output.units;
			this.unreadUpdates = 0;
		} else if (!this.followTail && this.tab === "output" && output.revision !== this.lastOutputRevision) {
			this.unreadUpdates += Math.max(1, output.units - this.lastOutputUnits);
		}
		this.lastOutputRevision = output.revision;
		this.lastOutputUnits = output.units;
		this.detailTotal = content.length;
		this.detailViewport = viewport;
		const maxOffset = Math.max(0, content.length - viewport);
		if (this.followTail) {
			this.detailOffset = maxOffset;
			this.unreadUpdates = 0;
		} else {
			this.detailOffset = Math.max(0, Math.min(this.detailOffset, maxOffset));
		}
		return [...header, ...content.slice(this.detailOffset, this.detailOffset + viewport)];
	}

	private detailLines(record: AgentRecord, width: number): string[] {
		if (this.tab === "assignment") return styleText(this.theme, record.assignment, width);
		if (this.tab === "activity") {
			if (record.events.length === 0) return [this.theme.fg("muted", "No activity yet.")];
			return record.events.flatMap((event) => {
				const detail =
					event.toolName ?? event.text?.trim() ?? (event.turnCount ? `turn ${event.turnCount}` : event.type);
				const color = event.type === "tool-start" ? "accent" : event.type === "tool-end" ? "success" : "dim";
				return detail ? [truncateToWidth(`${this.theme.fg(color, event.type)} ${detail}`, width, "…")] : [];
			});
		}
		if (record.session) {
			const transcript = renderSessionTranscript(record, this.theme, width);
			const sessionErrors = new Set(
				record.session.agent.state.messages.flatMap((message) =>
					message.role === "assistant" && message.errorMessage ? [message.errorMessage] : [],
				),
			);
			if (record.error && !sessionErrors.has(record.error)) {
				appendTranscriptText(transcript, "error", record.error, this.theme, width);
			}
			return transcript;
		}
		const output =
			record.error ||
			record.result ||
			record.events
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join("");
		if (!output) return [this.theme.fg("muted", record.status === "running" ? "Waiting for output…" : "No output.")];
		return styleText(this.theme, output, width, Boolean(record.error));
	}

	private renderTabs(width: number): string {
		return truncateToWidth(
			TABS.map((tab) =>
				tab === this.tab ? this.theme.fg("accent", `[ ${tab} ]`) : this.theme.fg("dim", `  ${tab}  `),
			).join(this.theme.fg("borderMuted", "│")),
			width,
			"…",
		);
	}

	private renderFooter(width: number): string {
		if (this.mode === "input") {
			this.input.focused = this.focused;
			const [inputLine = ""] = this.input.render(Math.max(1, width - this.inputAction.length - 4));
			return `${this.theme.fg("accent", `${this.inputAction}>`)} ${inputLine}`;
		}
		if (this.message) return this.theme.fg("accent", this.message);
		const start = this.detailTotal === 0 ? 0 : Math.min(this.detailTotal, this.detailOffset + 1);
		const end = Math.min(this.detailTotal, this.detailOffset + this.detailViewport);
		const state = this.followTail ? "following" : "paused";
		const unread = this.unreadUpdates > 0 ? ` · ${this.theme.fg("accent", `${this.unreadUpdates} new`)}` : "";
		return this.theme.fg("dim", `${state} · ${start}-${end}/${this.detailTotal}`) + unread;
	}

	private moveSelection(delta: number): void {
		if (this.records.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.records.length - 1, this.selectedIndex + delta));
		this.detailOffset = 0;
		this.followTail = true;
		this.unreadUpdates = 0;
		this.message = "";
		this.tui.requestRender();
	}

	private switchTab(delta: number): void {
		const index = TABS.indexOf(this.tab);
		this.tab = TABS[(index + delta + TABS.length) % TABS.length]!;
		this.detailOffset = 0;
		this.followTail = true;
		this.unreadUpdates = 0;
		this.tui.requestRender();
	}

	private scrollDetail(delta: number): void {
		this.followTail = false;
		this.setDetailOffset(this.detailOffset + delta);
	}

	private setDetailOffset(offset: number): void {
		this.detailOffset = Math.max(0, offset);
		this.tui.requestRender();
	}

	private pageSize(): number {
		return Math.max(1, Math.floor(this.tui.terminal.rows * 0.4));
	}

	private startInput(action: "steer" | "followUp"): void {
		const record = this.selectedRecord();
		if (!record) return;
		if (action === "steer" && record.status !== "running") {
			this.message = "Only running agents can be steered.";
			this.tui.requestRender();
			return;
		}
		if (action === "followUp" && record.status === "running") {
			this.message = "Use steer while the agent is running.";
			this.tui.requestRender();
			return;
		}
		this.inputAction = action;
		this.input.setValue("");
		this.mode = "input";
		this.tui.requestRender();
	}

	private async submitInput(value: string): Promise<void> {
		const record = this.selectedRecord();
		const message = value.trim();
		if (!record || !message) return;
		this.mode = "browse";
		const sent =
			this.inputAction === "steer"
				? await this.actions.steer(record.id, message)
				: await this.actions.followUp(record.id, message);
		this.message = sent ? `${this.inputAction} sent to ${record.id}` : `${record.id} is no longer available`;
		this.tui.requestRender();
	}

	private cancelInput(): void {
		this.mode = "browse";
		this.message = "";
		this.tui.requestRender();
	}

	private stopSelected(): void {
		const record = this.selectedRecord();
		if (!record) return;
		this.message = this.actions.stop(record.id) ? `Stopped ${record.id}` : `${record.id} is not running`;
		this.tui.requestRender();
	}

	private selectedRecord(): AgentRecord | undefined {
		this.clampSelection();
		return this.records[this.selectedIndex];
	}

	private clampSelection(): void {
		this.selectedIndex = Math.max(0, Math.min(Math.max(0, this.records.length - 1), this.selectedIndex));
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
	}

	private row(content: string, innerWidth: number): string {
		return `${this.theme.fg("borderAccent", "│")} ${pad(content, innerWidth)} ${this.theme.fg("borderAccent", "│")}`;
	}

	private separator(innerWidth: number): string {
		return this.row(this.theme.fg("borderAccent", "─".repeat(innerWidth)), innerWidth);
	}

	private borderTop(width: number): string {
		return this.theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`);
	}

	private borderBottom(width: number): string {
		return this.theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`);
	}
}

export async function openAgentBrowser(
	ctx: ExtensionCommandContext,
	records: AgentRecord[],
	actions: AgentHarnessActions,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	if (records.length === 0) {
		ctx.ui.notify("No subagents in this session.", "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AgentHarness(records, actions, tui, theme, () => done());
	});
}

export async function openAgentInspector(
	ctx: ExtensionCommandContext,
	record: AgentRecord | undefined,
	actions: AgentHarnessActions,
): Promise<void> {
	if (!record) {
		ctx.ui.notify("Subagent not found.", "warning");
		return;
	}
	if (!ctx.hasUI || !ctx.ui.custom) return;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new AgentHarness([record], actions, tui, theme, () => done(), record.id);
	});
}

function statusText(theme: Theme, status: AgentRecord["status"]): string {
	const color =
		status === "running"
			? "accent"
			: status === "completed"
				? "success"
				: status === "error" || status === "aborted" || status === "stopped"
					? "error"
					: "warning";
	return theme.fg(color, status);
}

function outputState(record: AgentRecord): { revision: string; units: number } {
	const chunks: string[] = [];
	if (record.session) {
		for (const message of record.session.agent.state.messages) {
			if (message.role === "user") {
				chunks.push(`user:${userMessageText(message.content)}`);
			} else if (message.role === "assistant") {
				chunks.push(`assistant:${assistantMessageText(message.content)}`);
				if (message.errorMessage) chunks.push(`error:${message.errorMessage}`);
				for (const content of message.content) {
					if (content.type === "toolCall")
						chunks.push(`tool:${content.id}:${content.name}:${JSON.stringify(content.arguments)}`);
				}
			} else if (message.role === "toolResult") {
				chunks.push(`result:${message.toolCallId}:${message.isError}:${toolResultText(message.content)}`);
			}
		}
		if (record.error) chunks.push(`record-error:${record.error}`);
	} else {
		chunks.push(
			record.error ||
				record.result ||
				record.events
					.filter((event) => event.type === "text")
					.map((event) => event.text)
					.join(""),
		);
	}
	const revision = chunks.join("\n");
	return { revision, units: revision ? revision.split(/\r?\n/).length : 0 };
}

function renderSessionTranscript(record: AgentRecord, theme: Theme, width: number): string[] {
	const messages = record.session?.agent.state.messages ?? [];
	const results = new Map(
		messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]),
	);
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = userMessageText(message.content);
			if (text) appendTranscriptText(lines, "user", text, theme, width);
			continue;
		}
		if (message.role !== "assistant") continue;
		const text = assistantMessageText(message.content);
		if (text) appendTranscriptText(lines, "assistant", text, theme, width);
		if (message.errorMessage) appendTranscriptText(lines, "error", message.errorMessage, theme, width);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const result = results.get(content.id);
			appendToolSummary(
				lines,
				content.name,
				content.arguments,
				result ? toolResultText(result.content) : undefined,
				Boolean(result?.isError),
				theme,
				width,
			);
		}
	}
	return lines.length > 0 ? lines : [theme.fg("muted", "Waiting for session transcript…")];
}

function appendToolSummary(
	lines: string[],
	name: string,
	args: unknown,
	result: string | undefined,
	error: boolean,
	theme: Theme,
	width: number,
): void {
	if (lines.length > 0) lines.push("");
	const state =
		result === undefined ? theme.fg("accent", "●") : theme.fg(error ? "error" : "success", error ? "✗" : "✓");
	const title = `${state} ${theme.fg(error ? "error" : "toolTitle", summarizeToolCall(name, args))}`;
	lines.push(truncateToWidth(title, width, "…"));
	const detail = summarizeToolResult(name, result, error);
	if (detail) lines.push(truncateToWidth(theme.fg(error ? "error" : "dim", `  ${detail}`), width, "…"));
}

function summarizeToolCall(name: string, args: unknown): string {
	const values = objectValues(args);
	const path = stringValue(values, "path") ?? stringValue(values, "file_path");
	if (name === "read") {
		const offset = numberValue(values, "offset");
		const limit = numberValue(values, "limit");
		const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit ? `+${limit}` : ""}` : "";
		return `read ${path ?? ""}${range}`.trim();
	}
	if (name === "write" || name === "edit" || name === "apply_patch") return `${name} ${path ?? ""}`.trim();
	if (name === "search") {
		const query = stringValue(values, "pattern") ?? stringValue(values, "query");
		return `search ${query ?? ""}${path ? ` in ${path}` : ""}`.trim();
	}
	if (name === "find") {
		const pattern = stringValue(values, "pattern") ?? stringArrayValue(values, "paths");
		return `find ${pattern ?? ""}${path ? ` in ${path}` : ""}`.trim();
	}
	if (name === "exec_command") return `exec ${firstLine(stringValue(values, "cmd") ?? "")}`.trim();
	const summary = Object.entries(values)
		.slice(0, 2)
		.map(([key, value]) => `${key}=${compactValue(value)}`)
		.join(" ");
	return `${name}${summary ? ` ${summary}` : ""}`;
}

function summarizeToolResult(name: string, result: string | undefined, error: boolean): string {
	if (result === undefined) return "running";
	const trimmed = result.trim();
	if (!trimmed) return error ? "failed" : "done";
	const lines = trimmed.split(/\r?\n/);
	if (name === "read") return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
	if (name === "search") return `${lines.length} match line${lines.length === 1 ? "" : "s"}`;
	if (name === "find") return `${lines.length} path${lines.length === 1 ? "" : "s"}`;
	if (name === "write" || name === "edit" || name === "apply_patch") return error ? firstLine(trimmed) : "updated";
	return firstLine(trimmed);
}

function objectValues(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(values: Record<string, unknown>, key: string): string | undefined {
	return typeof values[key] === "string" ? values[key] : undefined;
}

function numberValue(values: Record<string, unknown>, key: string): number | undefined {
	return typeof values[key] === "number" ? values[key] : undefined;
}

function stringArrayValue(values: Record<string, unknown>, key: string): string | undefined {
	const value = values[key];
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : undefined;
}

function compactValue(value: unknown): string {
	if (typeof value === "string") return firstLine(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	return value && typeof value === "object" ? "{…}" : String(value);
}

function firstLine(value: string): string {
	return value.split(/\r?\n/, 1)[0] ?? "";
}

function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function assistantMessageText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function appendTranscriptText(
	lines: string[],
	role: "user" | "assistant" | "error",
	text: string,
	theme: Theme,
	width: number,
): void {
	if (lines.length > 0) lines.push("");
	const color = role === "user" ? "accent" : role === "error" ? "error" : "success";
	lines.push(theme.fg(color, role));
	lines.push(...styleText(theme, text, width, role === "error"));
}

function styleText(theme: Theme, text: string, width: number, error = false): string[] {
	return text.split(/\r?\n/).flatMap((line) => {
		if (!line) return [""];
		const trimmed = line.trimStart();
		const color = error
			? "error"
			: /^#{1,6}\s/.test(trimmed)
				? "mdHeading"
				: /^```/.test(trimmed)
					? "mdCodeBlockBorder"
					: /^[-*+]\s/.test(trimmed)
						? "mdListBullet"
						: /`[^`]+`/.test(line)
							? "mdCode"
							: "text";
		return wrapTextWithAnsi(theme.fg(color, line), width);
	});
}

function pad(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text + " ".repeat(width - textWidth);
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
