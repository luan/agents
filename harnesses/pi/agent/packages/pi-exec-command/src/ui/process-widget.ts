import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ActivityAnimationOverrides,
	activityFrame,
	highlightSyntaxBlock,
	icon,
	type MotionMount,
	mountConfiguredAnimation,
	PointerInteractionController,
	sanitizeTuiField,
	type TuiTheme,
	tuiTheme,
	whenSyntaxReady,
} from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { ExecProcessSnapshot } from "../session-manager.ts";
import type { ProcessTerminalStore } from "./process-store.ts";

type HostTheme = Parameters<typeof tuiTheme>[0];
type UIContext = ExtensionContext["ui"];

interface ProcessTarget {
	readonly process: ExecProcessSnapshot;
	readonly row: number;
	readonly width: number;
}

/** Compact indication for running processes whose transcript rows may be offscreen. */
export class ProcessWidget {
	private uiCtx: UIContext | undefined;
	private motion: MotionMount | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private lastStatus: string | undefined;
	private animation: Readonly<ActivityAnimationOverrides>;
	private syntaxReadyRequested = false;
	private readonly unsubscribe: () => void;
	private readonly interaction = new PointerInteractionController<ProcessTarget>({
		key: ({ process }) => String(process.id),
		rect: ({ row, width }) => ({ x: 0, y: row, width, height: 1 }),
	});

	constructor(
		private readonly source: ProcessTerminalStore,
		private readonly openProcess: (processId: number) => void = () => {},
		animation: Readonly<ActivityAnimationOverrides> = {},
	) {
		this.animation = animation;
		this.unsubscribe = source.subscribe(() => this.update());
	}

	setAnimation(animation: Readonly<ActivityAnimationOverrides>): void {
		this.animation = animation;
		this.motion?.dispose();
		this.motion = undefined;
		this.syncMotion();
		this.tui?.requestRender();
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
					this.requestSyntaxReady();
					return {
						render: (width) => this.render(theme, width),
						onMouse: (event: TuiMouseEvent) => this.onMouse(event),
						invalidate() {},
					};
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
		const allRunning = runningProcesses(this.source.list());
		const running = allRunning.slice(0, 4);
		this.interaction.setTargets(
			running.map((process, index) => ({ process, row: index + 1, width: Math.max(0, width) })),
		);
		const hoveredId = this.interaction.hoveredTarget()?.process.id;
		return [
			`${colors.fg("accent", `${icon("terminal")} Processes`)} ${colors.fg("text.muted", `· ${allRunning.length} running`)}`,
			...running.map((process) => {
				const elapsed = formatDuration((now - process.startedAtMs) / 1_000);
				const output = lastOutputLine(process.output);
				const marker = activityFrame(colors, "", now - process.startedAtMs, this.animation).marker;
				const command = dimmedCommand(colors, process.command, process.shell, process.id === hoveredId);
				return truncateToWidth(
					`${marker ? `${marker} ` : ""}${colors.fg(process.id === hoveredId ? "accent" : "info", `#${process.id}`)} ${colors.fg("text.muted", `${elapsed} ·`)} ${command}${output ? colors.fg("text.muted", ` · ${output}`) : ""}`,
					width,
				);
			}),
		];
	}

	private onMouse(event: TuiMouseEvent): boolean {
		return this.interaction.handleMouse(
			{ ...event, screenCol: event.col, screenRow: event.row },
			{
				onHoverChange: () => this.tui?.requestRender(),
				onActivate: ({ process }) => this.openProcess(process.id),
			},
		);
	}

	private syncMotion(): void {
		const running = runningProcesses(this.source.list()).length > 0;
		if (this.tui && running && !this.motion) this.motion = mountConfiguredAnimation(this.tui, this.animation);
		if (!running && this.motion) {
			this.motion.dispose();
			this.motion = undefined;
		}
	}

	private requestSyntaxReady(): void {
		if (this.syntaxReadyRequested) return;
		this.syntaxReadyRequested = true;
		whenSyntaxReady(() => this.tui?.requestRender());
	}

	private clear(): void {
		this.motion?.dispose();
		this.motion = undefined;
		this.tui = undefined;
		this.interaction.clear();
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("processes", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("processes", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}

function dimmedCommand(colors: TuiTheme, command: string, shell: string, hovered: boolean): string {
	const source = sanitizeTuiField(command);
	const spans = highlightSyntaxBlock(source, shellSyntaxPath(shell))[0] ?? [{ text: source }];
	const dimAmount = hovered ? 0.35 : 0.65;
	return spans
		.map((span) =>
			colors.fg(colors.mixForeground(span.foreground ?? "text.primary", "text.muted", dimAmount), span.text),
		)
		.join("");
}

function shellSyntaxPath(shell: string): string {
	const basename = shell
		.replace(/\\/gu, "/")
		.split("/")
		.at(-1)
		?.toLowerCase()
		.replace(/\.exe$/u, "");
	return basename === "bash" || basename === "fish" || basename === "zsh" ? `script.${basename}` : "script.sh";
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
