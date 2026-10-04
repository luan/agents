import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	type MotionMount,
	sanitizeTuiFieldPreview,
	sharedMotionScheduler,
	tuiTheme,
} from "@luan.sh/pi-libtui";
import { ToolActivity, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";
import { ActivityTimings, formatActivityDuration } from "./activity-timing.ts";

type ActivityEntry = Exclude<TranscriptEntry, { kind: "content" }>;

/** Use a provider's latest heading or paragraph; do not invent a reasoning summary. */
export function activitySummary(entry: ActivityEntry): string {
	if (entry.kind === "tool") return sanitizeTuiFieldPreview(entry.summary.replace(/^[^\p{L}\p{N}$]+/u, ""), 240);
	const tail = entry.summary.slice(-8_000);
	const headings = [...tail.matchAll(/(?:^|\n)\s*(?:\*\*([^\n]+?)\*\*|#{1,6}\s+([^\n]+))/gu)];
	const heading = headings.at(-1);
	const paragraph = tail
		.trim()
		.split(/\n\s*\n/u)
		.at(-1)
		?.split("\n")[0];
	return sanitizeTuiFieldPreview(heading?.[1] ?? heading?.[2] ?? paragraph ?? "Thinking", 240);
}

class ActivitySection extends ComponentStack {
	private readonly body = new ComponentStack();
	private readonly failurePreview = new ComponentStack();
	private readonly activity: ToolActivity;
	private entries: readonly ActivityEntry[] = [];
	private clock: MotionMount | undefined;
	private summary = "";
	private running = false;
	private failures = 0;

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings: ActivityTimings,
		private readonly now: () => number,
	) {
		super();
		this.activity = new ToolActivity({
			theme,
			requestRender,
			action: { render: (width) => this.renderHeader(width), invalidate() {} },
			view: { action: { verb: "Working", status: "running" } },
		});
		this.setChildren([new Spacer(1), this.activity]);
	}

	update(entries: readonly ActivityEntry[], active: boolean): void {
		const running = active || entries.some((entry) => entry.running);
		if (
			running === this.running &&
			entries.length === this.entries.length &&
			entries.every((entry, index) => entry === this.entries[index])
		)
			return;
		this.entries = entries;
		this.body.setChildren(entries.map((entry) => entry.component));
		// Failures stay visible without expanding successful output or thinking.
		this.failurePreview.setChildren(entries.filter((entry) => entry.failed).map((entry) => entry.component));
		// Keep the model's intent visible while tools run and after they finish.
		const latest =
			entries.filter((entry) => entry.kind === "thinking" && entry.summary.trim()).at(-1) ?? entries.at(-1)!;
		const failures = entries.filter((entry) => entry.failed).length;
		this.summary = activitySummary(latest);
		this.running = running;
		this.failures = failures;
		if (running && !this.clock)
			this.clock = sharedMotionScheduler.mount({ requestRender: this.requestRender }, { cadenceMs: 1_000 });
		else if (!running) {
			this.clock?.dispose();
			this.clock = undefined;
		}
		this.activity.update({
			action: {
				verb: this.summary,
				status: failures ? "failed" : running ? "running" : "succeeded",
				marker: false,
			},
			running,
			payload: { kind: "component", preview: this.failurePreview, full: this.body },
		});
	}

	render(width: number): string[] {
		const rows = super.render(width);
		// Extend the underline through the empty columns, not just the disclosure text.
		if (rows[1]) {
			const colors = tuiTheme(this.theme);
			const padding = " ".repeat(Math.max(0, Math.floor(width) - visibleWidth(rows[1])));
			// The chevron closes its foreground; paint the remaining columns explicitly.
			const row = rows[1] + colors.fg("text.muted", padding);
			// Pi exposes only solid underlines; select dotted SGR styling at this terminal boundary.
			const underlined = this.theme.underline(row).replaceAll("\x1b[4m", "\x1b[4:4m");
			rows[1] = colors.fg("text.muted", underlined);
		}
		return rows;
	}

	private renderHeader(width: number): string[] {
		if (width <= 0) return [];
		const elapsed = this.timings.elapsed(this.entries, this.now(), this.running);
		const duration = elapsed === undefined ? "" : ` for ${formatActivityDuration(elapsed)}`;
		const label = `  ${this.running ? "Working" : "Worked"}${duration} · ${this.theme.italic(this.summary)}`;
		const steps = `${this.entries.length} ${this.entries.length === 1 ? "step" : "steps"}`;
		const failed = this.failures ? ` · ${this.failures} failed` : "";
		return [truncateToWidth(`${label} · ${steps}${failed}`, width, "…")];
	}

	dispose(): void {
		this.clock?.dispose();
		this.activity.dispose();
	}
}

/** Fold consecutive tools/thinking, leaving assistant text and every other message in place. */
export class ActivityTranscript extends ComponentStack {
	private readonly sections = new Map<object, ActivitySection>();
	private completedBeforeTurn: Set<object> | undefined;

	constructor(
		private readonly entries: () => readonly TranscriptEntry[],
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly timings = new ActivityTimings(),
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	beginTurn(): void {
		// Retries and automatic continuations belong to the same activity group.
		this.completedBeforeTurn ??= new Set(this.entries().map((entry) => entry.key));
		this.requestRender();
	}

	finishTurn(): void {
		this.completedBeforeTurn = undefined;
		this.requestRender();
	}

	render(width: number): string[] {
		const children: Component[] = [];
		const retained = new Set<object>();
		let pending: ActivityEntry[] = [];
		const flush = (active = false) => {
			if (!pending.length) return;
			const key = pending[0]!.key;
			let section = this.sections.get(key);
			if (!section) {
				section = new ActivitySection(this.theme, this.requestRender, this.timings, this.now);
				this.sections.set(key, section);
			}
			section.update(pending, active);
			children.push(section);
			retained.add(key);
			pending = [];
		};
		for (const entry of this.entries()) {
			if (entry.kind !== "content") pending.push(entry);
			else {
				flush();
				children.push(entry.component);
			}
		}
		const beforeTurn = this.completedBeforeTurn;
		flush(beforeTurn !== undefined && pending.some((entry) => !beforeTurn.has(entry.key)));
		for (const [key, section] of this.sections) {
			if (retained.has(key)) continue;
			section.dispose();
			this.sections.delete(key);
		}
		this.setChildren(children);
		return super.render(width);
	}

	dispose(): void {
		for (const section of this.sections.values()) section.dispose();
		this.sections.clear();
	}
}
