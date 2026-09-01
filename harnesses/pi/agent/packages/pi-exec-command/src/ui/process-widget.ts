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
	sanitizeTuiFieldPreview,
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

interface ProcessPreview {
	readonly command: string;
	readonly shell: string;
	readonly output: string;
	readonly width: number;
	readonly commandSpans: ReturnType<typeof highlightSyntaxBlock>[number];
	readonly outputLine: string;
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
	private readonly previews = new Map<number, ProcessPreview>();
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
				const preview = this.preview(process, width);
				const marker = activityFrame(colors, "", now - process.startedAtMs, this.animation).marker;
				const command = dimmedCommand(colors, preview.commandSpans, process.id === hoveredId);
				return truncateToWidth(
					`${marker ? `${marker} ` : ""}${colors.fg(process.id === hoveredId ? "accent" : "info", `#${process.id}`)} ${colors.fg("text.muted", `${elapsed} ·`)} ${command}${preview.outputLine ? colors.fg("text.muted", ` · ${preview.outputLine}`) : ""}`,
					width,
				);
			}),
		];
	}

	private preview(process: ExecProcessSnapshot, width: number): ProcessPreview {
		const cached = this.previews.get(process.id);
		if (
			cached?.command === process.command &&
			cached.shell === process.shell &&
			cached.output === process.output &&
			cached.width === width
		) {
			return cached;
		}
		if (!cached && this.previews.size >= 8) this.previews.clear();
		const commandSource = truncateToWidth(fieldPreview(process.command, Math.max(1, width * 2)), width);
		const preview = {
			command: process.command,
			shell: process.shell,
			output: process.output,
			width,
			commandSpans: highlightSyntaxBlock(commandSource, shellSyntaxPath(process.shell))[0] ?? [{ text: commandSource }],
			outputLine: lastOutputLine(process.output, width),
		};
		this.previews.set(process.id, preview);
		return preview;
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
		this.previews.clear();
		if (this.uiCtx && this.registered) this.uiCtx.setWidget("processes", undefined);
		if (this.uiCtx && this.lastStatus !== undefined) this.uiCtx.setStatus("processes", undefined);
		this.registered = false;
		this.lastStatus = undefined;
	}
}

function dimmedCommand(
	colors: TuiTheme,
	spans: ReturnType<typeof highlightSyntaxBlock>[number],
	hovered: boolean,
): string {
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

function lastOutputLine(output: string, width: number): string {
	const budget = Math.max(1, width * 2);
	const clipped = output.length > budget;
	const tail = output.slice(-budget).trimEnd();
	if (!tail) return clipped ? "…" : "";
	const newline = tail.lastIndexOf("\n");
	const prefix = clipped && newline < 0 ? "…" : "";
	return truncateToWidth(`${prefix}${sanitizeTuiField(tail.slice(newline + 1))}`, width, "…");
}

function fieldPreview(value: string, maximumCharacters: number): string {
	return sanitizeTuiFieldPreview(value, maximumCharacters);
}

function formatDuration(seconds: number): string {
	if (seconds < 10) return `${Math.max(0, seconds).toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds % 60)}s`;
}
