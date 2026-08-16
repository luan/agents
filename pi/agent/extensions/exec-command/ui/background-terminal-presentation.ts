import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	type AnimationMount,
	registerExtensionMessageRenderer,
	setOrderedAboveEditorWidget,
	sharedAnimationRenderScheduler,
} from "../../shared/tui";
import {
	type RenderTheme,
	rawCommandToExecCell,
	renderBackgroundTerminalHud,
	renderExecCellComponent,
} from "../tools/exec-cell-presentation.ts";
import type { ExecSessionRecord } from "../tools/exec-session-manager.ts";

const STATUS_KEY = "background-terminals";
const HUD_FRAME_MS = 32;

export interface BackgroundTerminalStatusUi {
	setStatus(key: string, text: string | undefined): void;
	setWidget?(
		key: string,
		content:
			| undefined
			| ((
					tui: { requestRender(): void },
					theme: RenderTheme,
			  ) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface BackgroundTerminalFinishedDetails {
	process_id: number;
	command: string;
	shell?: string;
	output: string;
	exit_code?: number;
	terminal_state?: "exited" | "cancelled" | "session_error";
	cancelled?: boolean;
	session_error?: string;
	elapsed_ms: number;
	output_truncated: boolean;
	original_token_count?: number;
	artifact_capture?: {
		artifact_id: string;
		byte_count: number;
		line_count: number;
		returned_bytes: number;
		omitted_bytes: number;
	};
	artifact_capture_failure?: string;
	artifact_capture_truncated?: boolean;
	capture_output?: string;
	capture_output_truncated?: boolean;
}

export function registerBackgroundTerminalMessageRenderers(
	pi: ExtensionAPI,
	completedMessage: string,
	sessionErrorMessage: string,
): void {
	const render = (
		message: { details?: BackgroundTerminalFinishedDetails },
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
	) => {
		const details = message.details;
		if (!details) return undefined;
		const failed =
			(details.exit_code !== undefined && details.exit_code !== 0) ||
			details.cancelled === true ||
			details.terminal_state === "session_error";
		const footer = (() => {
			if (details.terminal_state === "session_error") return theme.fg("muted", "Session error");
			if (details.cancelled) return theme.fg("muted", "Cancelled");
			if (details.exit_code !== undefined && details.exit_code !== 0) {
				return theme.fg("muted", `Exit code: ${details.exit_code}`);
			}
			return undefined;
		})();
		return renderExecCellComponent(
			rawCommandToExecCell({
				command: details.command,
				shell: details.shell ?? process.env.SHELL,
				status: "done",
				elapsedMs: details.elapsed_ms,
				failed,
				outputBlock: {
					output: details.output,
					footer,
					options: { expanded, maxLines: 8 },
				},
			}),
			{ theme },
		);
	};
	registerExtensionMessageRenderer(pi, completedMessage, render);
	registerExtensionMessageRenderer(pi, sessionErrorMessage, render);
}

export function isExecInterruptInput(data: string): boolean {
	return matchesKey(data, Key.escape);
}

export class BackgroundTerminalPresentation {
	private ui: BackgroundTerminalStatusUi | undefined;
	private lastStatus: string | undefined;
	private widgetRegistered = false;
	private widgetTui: { requestRender(): void } | undefined;
	private widgetTimer: AnimationMount | undefined;
	private readonly outputSummaries = new Map<number, { output: string; lineCount: number; lastLine?: string }>();

	constructor(
		private readonly listSessions: () => ExecSessionRecord[],
		private readonly summarizeOutput: (output: string) => { lineCount: number; lastLine?: string },
	) {}

	setContext(ctx: ExtensionContext | undefined): void {
		if (ctx?.hasUI === false) return;
		const ui = ctx?.ui as BackgroundTerminalStatusUi | undefined;
		if (!ui?.setStatus) return;
		this.ui = ui;
		this.update();
	}

	update(): void {
		if (!this.ui) return;
		const records = this.listSessions();
		const running = records.filter((record) => record.running);
		const nextStatus =
			records.length === 0
				? undefined
				: (() => {
						const ttyCount = records.filter((record) => record.stdinOpen).length;
						const terminalNoun = `background terminal${records.length === 1 ? "" : "s"}`;
						return `${records.length} ${terminalNoun} · ${running.length} running${ttyCount > 0 ? ` · ${ttyCount} tty` : ""}`;
					})();
		if (nextStatus !== this.lastStatus) {
			this.ui.setStatus(STATUS_KEY, nextStatus);
			this.lastStatus = nextStatus;
		}
		if (running.length === 0) this.clearWidget();
		else this.registerOrRefreshWidget();
	}

	clear(): void {
		this.clearWidget();
		this.ui?.setStatus(STATUS_KEY, undefined);
		this.ui = undefined;
		this.lastStatus = undefined;
	}

	private outputSummary(record: ExecSessionRecord) {
		const cached = this.outputSummaries.get(record.id);
		if (cached?.output === record.output) return cached;
		const summary = { output: record.output, ...this.summarizeOutput(record.output) };
		this.outputSummaries.set(record.id, summary);
		return summary;
	}

	private renderWidget(theme: RenderTheme, width: number): string[] {
		const running = this.listSessions().filter((record) => record.running);
		const runningIds = new Set(running.map((record) => record.id));
		for (const id of this.outputSummaries.keys()) {
			if (!runningIds.has(id)) this.outputSummaries.delete(id);
		}
		if (running.length === 0) return [];
		const lines = running.slice(0, 4).map((record) => {
			const summary = this.outputSummary(record);
			return renderBackgroundTerminalHud(
				{
					id: record.id,
					command: record.command,
					output: record.output,
					lineCount: summary.lineCount,
					lastLine: summary.lastLine,
					startedAtMs: record.startedAtMs,
					stdinOpen: record.stdinOpen,
				},
				{ theme, width },
			);
		});
		const omitted = running.length - lines.length;
		if (omitted > 0) {
			lines.push(theme.fg("dim", `… ${omitted} more background terminal${omitted === 1 ? "" : "s"}`));
		}
		return lines;
	}

	private registerOrRefreshWidget(): void {
		if (!this.ui?.setWidget) return;
		if (!this.widgetRegistered) {
			setOrderedAboveEditorWidget(
				this.ui as { setWidget: NonNullable<BackgroundTerminalStatusUi["setWidget"]> },
				STATUS_KEY,
				(tui, theme) => {
					this.widgetTui = tui;
					return {
						render: (width) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetTimer?.dispose();
							this.widgetTimer = undefined;
							this.widgetRegistered = false;
							this.widgetTui = undefined;
						},
					};
				},
			);
			this.widgetRegistered = true;
		}
		if (!this.widgetTimer && this.widgetTui) {
			this.widgetTimer = sharedAnimationRenderScheduler.mount(this.widgetTui, HUD_FRAME_MS);
		}
	}

	private clearWidget(): void {
		this.widgetTimer?.dispose();
		this.widgetTimer = undefined;
		if (this.widgetRegistered) {
			setOrderedAboveEditorWidget(
				this.ui as { setWidget: NonNullable<BackgroundTerminalStatusUi["setWidget"]> },
				STATUS_KEY,
				undefined,
			);
		}
		this.widgetRegistered = false;
		this.widgetTui = undefined;
		this.outputSummaries.clear();
	}
}
