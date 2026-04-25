import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import type { TeamEvent, TeamRecord, TeamSummary, TeamTask, WorkerRecord } from "./types.js";
import { TASK_STATUS_ICON, WORKER_STATUS_ICON } from "./types.js";

type ThemeLike = { fg(color: string, text: string): string; bold(text: string): string };

export type TeamDashboardAction =
	| { type: "close" }
	| { type: "refresh" }
	| { type: "message"; worker: WorkerRecord }
	| { type: "togglePause" }
	| { type: "stop"; worker?: WorkerRecord }
	| { type: "openPath"; path: string };

type Pane = "workers" | "tasks" | "events";

export class TeamDashboard {
	private pane: Pane = "workers";
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private summary: TeamSummary,
		private theme: ThemeLike,
		private onAction: (action: TeamDashboardAction) => void,
	) {}

	setSummary(summary: TeamSummary): void {
		this.summary = summary;
		this.invalidate();
	}

	handleInput(data: string): void {
		const rows = this.currentRows().length;
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, rows - 1), this.selected + 1);
		else if (matchesKey(data, Key.tab)) this.nextPane();
		else if (matchesKey(data, Key.shift("tab"))) this.prevPane();
		else if (matchesKey(data, Key.enter)) this.inspectSelected();
		else if (data === "m") this.messageSelected();
		else if (data === "p") this.onAction({ type: "togglePause" });
		else if (data === "s") this.stopSelected();
		else if (data === "r") this.onAction({ type: "refresh" });
		else if (data === "o") this.openSelectedPath();
		else if (matchesKey(data, Key.escape)) this.onAction({ type: "close" });
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const w = Math.max(48, width);
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, w, "…", true));
		const { team, workers, tasks, events } = this.summary;
		const doneTasks = tasks.filter((task) => task.status === "completed").length;
		push(this.borderTop(` Team: ${team.name} `, w));
		push(`│ ${this.label("Objective")} ${truncateToWidth(team.objective, w - 14, "…", true).padEnd(Math.max(0, w - 14))} │`);
		push(`│ ${this.label("Status")} ${team.status.padEnd(10)} Tasks ${String(doneTasks).padStart(2)}/${String(tasks.length).padEnd(2)} Workers ${String(workers.length).padEnd(2)}${" ".repeat(Math.max(0, w - 48))} │`);
		push(this.section("Workers", w, this.pane === "workers"));
		for (const line of this.workerLines(w)) push(line);
		push(this.section("Task Board", w, this.pane === "tasks"));
		for (const line of this.taskLines(w)) push(line);
		push(this.section("Event Log", w, this.pane === "events"));
		for (const line of this.eventLines(events, w)) push(line);
		push(this.detailLine(w));
		push(this.borderBottom(" ↑↓ move  tab panes  enter inspect  m message  p pause  s stop  r refresh  esc ", w));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private currentRows(): Array<WorkerRecord | TeamTask | TeamEvent> {
		if (this.pane === "workers") return this.summary.workers;
		if (this.pane === "tasks") return this.summary.tasks;
		return this.summary.events;
	}

	private nextPane(): void {
		this.pane = this.pane === "workers" ? "tasks" : this.pane === "tasks" ? "events" : "workers";
		this.selected = 0;
	}

	private prevPane(): void {
		this.pane = this.pane === "workers" ? "events" : this.pane === "tasks" ? "workers" : "tasks";
		this.selected = 0;
	}

	private inspectSelected(): void {
		const row = this.currentRows()[this.selected];
		if (this.pane === "workers" && row) this.onAction({ type: "message", worker: row as WorkerRecord });
	}

	private messageSelected(): void {
		const row = this.currentRows()[this.selected];
		if (this.pane === "workers" && row) this.onAction({ type: "message", worker: row as WorkerRecord });
	}

	private stopSelected(): void {
		const row = this.currentRows()[this.selected];
		this.onAction({ type: "stop", worker: this.pane === "workers" ? (row as WorkerRecord | undefined) : undefined });
	}

	private openSelectedPath(): void {
		const row = this.currentRows()[this.selected];
		if (this.pane === "workers") {
			const worker = row as WorkerRecord | undefined;
			const path = worker?.worktree?.path ?? worker?.sessionFile;
			if (path) this.onAction({ type: "openPath", path });
		}
		if (this.pane === "tasks") {
			const task = row as TeamTask | undefined;
			if (task?.files[0]) this.onAction({ type: "openPath", path: task.files[0] });
		}
	}

	private workerLines(width: number): string[] {
		const workers = this.summary.workers.slice(0, 5);
		if (workers.length === 0) return [this.row("No workers yet", width)];
		return workers.map((worker, index) => {
			const selected = this.pane === "workers" && index === this.selected;
			const prefix = selected ? ">" : " ";
			const text = `${prefix} ${WORKER_STATUS_ICON[worker.status]} ${worker.name.padEnd(14)} ${worker.status.padEnd(10)} ${worker.currentTaskId ?? ""} ${worker.lastSummary ?? ""}`;
			return this.row(text, width, selected);
		});
	}

	private taskLines(width: number): string[] {
		const tasks = this.summary.tasks.slice(0, 6);
		if (tasks.length === 0) return [this.row("No tasks yet", width)];
		return tasks.map((task, index) => {
			const selected = this.pane === "tasks" && index === this.selected;
			const prefix = selected ? ">" : " ";
			return this.row(`${prefix} ${TASK_STATUS_ICON[task.status]} ${task.id.slice(0, 14).padEnd(14)} ${task.subject.padEnd(36)} ${task.owner ?? task.status}`, width, selected);
		});
	}

	private eventLines(events: TeamEvent[], width: number): string[] {
		const list = events.slice(-4).reverse();
		if (list.length === 0) return [this.row("No events yet", width)];
		return list.map((event, index) => {
			const selected = this.pane === "events" && index === this.selected;
			const time = event.createdAt.slice(11, 16);
			return this.row(`${selected ? ">" : " "} ${time} ${event.actor ? `${event.actor}: ` : ""}${event.message}`, width, selected);
		});
	}

	private detailLine(width: number): string {
		const row = this.currentRows()[this.selected];
		let text = "";
		if (this.pane === "workers" && row) text = (row as WorkerRecord).lastResult ?? (row as WorkerRecord).sessionFile ?? "";
		if (this.pane === "tasks" && row) text = (row as TeamTask).description;
		if (this.pane === "events" && row) text = JSON.stringify((row as TeamEvent).details ?? {});
		return this.row(`Details: ${text || "select a row"}`, width);
	}

	private label(text: string): string {
		return this.theme.fg("accent", this.theme.bold(text.padEnd(9)));
	}

	private row(text: string, width: number, selected = false): string {
		const body = truncateToWidth(selected ? this.theme.fg("accent", text) : text, Math.max(1, width - 4), "…", true);
		return `│ ${body}${" ".repeat(Math.max(0, width - 4 - visibleWidth(body)))} │`;
	}

	private borderTop(title: string, width: number): string {
		return `╭─${this.theme.fg("accent", title)}${"─".repeat(Math.max(0, width - visibleWidth(title) - 3))}╮`;
	}

	private section(title: string, width: number, active: boolean): string {
		const text = ` ${title}${active ? " *" : ""} `;
		return `├─${this.theme.fg(active ? "accent" : "muted", text)}${"─".repeat(Math.max(0, width - visibleWidth(text) - 3))}┤`;
	}

	private borderBottom(help: string, width: number): string {
		return `╰─${this.theme.fg("dim", truncateToWidth(help, Math.max(1, width - 3), "", true))}${"─".repeat(Math.max(0, width - visibleWidth(help) - 3))}╯`;
	}
}

export function renderCompactWidget(summary: TeamSummary, theme: ThemeLike, width: number): string[] {
	const done = summary.tasks.filter((task) => task.status === "completed").length;
	const running = summary.workers.filter((worker) => worker.status === "running").length;
	const lines = [
		`👥 team ${summary.team.name}  ${summary.workers.length} workers  ${running} running  ${done}/${summary.tasks.length} tasks`,
		...summary.workers.slice(0, 3).map((worker) => `  ${WORKER_STATUS_ICON[worker.status]} ${worker.name}: ${worker.lastSummary ?? worker.status}`),
	];
	return lines.map((line, index) => truncateToWidth(index === 0 ? theme.fg("accent", line) : line, width, "…", true));
}
