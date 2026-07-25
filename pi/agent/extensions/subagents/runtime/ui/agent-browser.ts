import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	SelectList,
	type SelectListTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { formatMs } from "./agent-widget.js";

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

class AgentListComponent implements Component {
	constructor(
		private readonly list: SelectList,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		return [
			this.theme.bold("Subagents"),
			this.theme.fg("dim", "Enter inspect | Esc close"),
			"",
			...this.list.render(width),
		];
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

class AgentInspectorComponent implements Component {
	private readonly interval: ReturnType<typeof setInterval>;

	constructor(
		private readonly record: AgentRecord,
		private readonly theme: Theme,
		private readonly close: () => void,
		requestRender: () => void,
	) {
		this.interval = setInterval(requestRender, 1000);
		this.interval.unref();
	}

	render(width: number): string[] {
		const record = this.record;
		const duration = formatMs((record.completedAt ?? Date.now()) - record.startedAt);
		const usage = getLifetimeTotal(record.lifetimeUsage);
		const lines = [
			this.theme.bold(`${record.description} | ${record.id}`),
			this.theme.fg("dim", "Esc/q close"),
			"",
			`Status: ${record.status}${record.isBackground ? " | background" : ""}`,
			`Agent: ${record.type}${record.modelName ? ` | ${record.modelName}` : ""}${record.thinkingLevel ? ` | ${record.thinkingLevel}` : ""}`,
			`Usage: ${record.toolUses} tools | ${usage} tokens | ${duration}`,
			`Session: ${record.sessionFile ?? "not created"}`,
			`Parent: ${record.parentAgentId ?? "root"}`,
			"",
			this.theme.bold("Assignment"),
			...record.assignment.split(/\r?\n/),
		];
		if (record.events.length > 0) {
			lines.push("", this.theme.bold("Recent activity"));
			for (const event of record.events.slice(-12)) {
				const detail =
					event.toolName ?? event.text?.trim() ?? (event.turnCount ? `turn ${event.turnCount}` : event.type);
				if (detail) lines.push(`${event.type}: ${detail}`);
			}
		}
		const output = record.error || record.result;
		if (output)
			lines.push("", this.theme.bold(record.error ? "Error" : "Output"), ...output.split(/\r?\n/).slice(-20));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") this.close();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.interval);
	}
}

export async function openAgentBrowser(ctx: ExtensionCommandContext, records: AgentRecord[]): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	if (records.length === 0) {
		ctx.ui.notify("No subagents in this session.", "info");
		return;
	}
	const selectedId = await ctx.ui.custom<string | undefined>(
		(_tui, theme, _keybindings, done) => {
			const listTheme: SelectListTheme = {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("dim", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			};
			const list = new SelectList(
				[...records]
					.sort((left, right) => left.id.localeCompare(right.id))
					.map((record) => {
						const depth = Math.max(0, record.id.split("/").filter(Boolean).length - 2);
						return {
							value: record.id,
							label: `${"  ".repeat(depth)}${record.status === "running" ? "*" : record.status === "completed" ? "+" : "-"} ${record.description}`,
							description: `${record.type} | ${record.id} | ${formatMs((record.completedAt ?? Date.now()) - record.startedAt)}`,
						};
					}),
				12,
				listTheme,
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			return new AgentListComponent(list, theme);
		},
		{ overlay: true },
	);
	if (selectedId)
		await openAgentInspector(
			ctx,
			records.find((record) => record.id === selectedId),
		);
}

export async function openAgentInspector(ctx: ExtensionCommandContext, record: AgentRecord | undefined): Promise<void> {
	if (!record) {
		ctx.ui.notify("Subagent not found.", "warning");
		return;
	}
	if (!ctx.hasUI || !ctx.ui.custom) return;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new AgentInspectorComponent(
				record,
				theme,
				() => done(),
				() => tui.requestRender(),
			),
		{ overlay: true },
	);
}
