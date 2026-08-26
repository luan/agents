import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { MotionMount } from "pi-libtui";
import { icon, mountConfiguredAnimation, sanitizeTuiField, tuiTheme } from "pi-libtui";
import type { ExecProcessSnapshot } from "../session-manager.ts";
import type { ProcessTerminalStore } from "./process-store.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];
type UIContext = ExtensionContext["ui"];

/** Compact indication for running processes whose transcript rows may be offscreen. */
export class ProcessWidget {
	private uiCtx: UIContext | undefined;
	private motion: MotionMount | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private lastStatus: string | undefined;
	private readonly unsubscribe: () => void;

	constructor(private readonly source: ProcessTerminalStore) {
		this.unsubscribe = source.subscribe(() => this.update());
	}

	setUICtx(ctx: UIContext): void {
		if (ctx === this.uiCtx) return;
		this.clear();
		this.uiCtx = ctx;
		this.update();
	}

	update(): void {
		if (!this.uiCtx) return;
		const running = runningProcesses(this.source.list());
		if (running.length === 0) {
			this.clear();
			return;
		}
		const status = `${running.length} running process${running.length === 1 ? "" : "es"}`;
		if (status !== this.lastStatus) {
			this.uiCtx.setStatus("processes", status);
			this.lastStatus = status;
		}
		if (!this.registered) {
			this.uiCtx.setWidget(
				"processes",
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
		const running = runningProcesses(this.source.list());
		return [
			`${colors.fg("accent", `${icon("code-mode")} Processes`)} ${colors.fg("text.muted", `· ${running.length} running`)}`,
			...running.slice(0, 4).map((process) => {
				const elapsed = formatDuration((now - process.startedAtMs) / 1_000);
				const output = lastOutputLine(process.output);
				return truncateToWidth(
					`${colors.fg("info", `#${process.id}`)} ${colors.fg("text.muted", `${elapsed} ·`)} ${colors.fg("text.primary", sanitizeTuiField(process.command))}${output ? colors.fg("text.muted", ` · ${output}`) : ""}`,
					width,
				);
			}),
		];
	}

	private syncMotion(): void {
		const running = runningProcesses(this.source.list()).length > 0;
		if (this.tui && running && !this.motion) this.motion = mountConfiguredAnimation(this.tui);
		if (!running && this.motion) {
			this.motion.dispose();
			this.motion = undefined;
		}
	}

	private clear(): void {
		this.motion?.dispose();
		this.motion = undefined;
		this.tui = undefined;
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("processes", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("processes", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}

function runningProcesses(snapshots: readonly ExecProcessSnapshot[]): readonly ExecProcessSnapshot[] {
	return snapshots.filter(({ state }) => state === "running");
}

function lastOutputLine(output: string): string {
	const lines = output.trimEnd().split("\n");
	return sanitizeTuiField(lines.at(-1) ?? "");
}

function formatDuration(seconds: number): string {
	if (seconds < 10) return `${Math.max(0, seconds).toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds % 60)}s`;
}
