import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ActivityAnimationOverrides } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { type TerminalOutputUpdate, ToolActivity, type ToolTranscriptStatus } from "pi-libtui/tool";
import { ShellCommandAction } from "./shell-command-action.ts";

export interface CommandTranscriptView {
	command: string;
	shell?: string;
	status: ToolTranscriptStatus;
	running?: boolean;
	output?: string;
	outputRevision?: number;
	tty?: boolean;
	/** How this snapshot updates previously rendered output. */
	outputUpdate?: TerminalOutputUpdate;
	meta?: readonly string[];
	failure?: string;
	expanded?: boolean;
}

export interface CommandTranscriptOptions {
	theme: Theme;
	view: CommandTranscriptView;
	requestRender(): void;
	previewRows?: number;
	fullRows?: number;
	maxCharacters?: number;
	animation?: Readonly<ActivityAnimationOverrides>;
}

/** Shell-prompt preset over the domain-free streaming ToolActivity. */
export class CommandTranscript implements Component {
	private readonly activity: ToolActivity;
	private readonly action: ShellCommandAction;
	private outputSnapshot: string | undefined;
	private inferredOutputRevision = 0;

	constructor(options: CommandTranscriptOptions) {
		const view = this.withOutputRevision(options.view);
		this.action = new ShellCommandAction({
			theme: options.theme,
			view: shellView(view),
			requestRender: options.requestRender,
			animation: options.animation,
		});
		this.activity = new ToolActivity({
			...options,
			textSelection: "tail",
			action: this.action,
			view: activityView(view),
		});
	}

	update(view: CommandTranscriptView): void {
		const resolved = this.withOutputRevision(view);
		this.action.update(shellView(resolved));
		this.activity.update(activityView(resolved));
	}
	render(width: number): string[] {
		return this.activity.render(width);
	}
	get children(): readonly Component[] {
		return this.activity.children;
	}
	getSpans() {
		return this.activity.getSpans();
	}
	onMouse(event: TuiMouseEvent): boolean {
		return this.activity.onMouse(event);
	}
	invalidate(): void {
		this.activity.invalidate();
	}
	dispose(): void {
		this.activity.dispose();
	}

	private withOutputRevision(view: CommandTranscriptView): CommandTranscriptView {
		if (view.output !== this.outputSnapshot) {
			this.outputSnapshot = view.output;
			this.inferredOutputRevision++;
		}
		if (view.output === undefined || view.outputRevision !== undefined) return view;
		return { ...view, outputRevision: this.inferredOutputRevision };
	}
}

function activityView(view: CommandTranscriptView) {
	return {
		action: { verb: view.command, status: view.status, marker: "$", meta: view.meta },
		running: view.running ?? view.status === "running",
		payload:
			view.output === undefined
				? undefined
				: view.tty
					? {
							kind: "terminal" as const,
							text: view.output,
							revision: view.outputRevision,
							update: view.outputUpdate,
						}
					: {
							kind: "text" as const,
							text: view.output,
							revision: view.outputRevision ?? 0,
							update: view.outputUpdate === "cumulative-tail" ? "replace" : view.outputUpdate,
						},
		failure: view.failure,
		mode: view.expanded ? ("full" as const) : ("preview" as const),
	};
}

function shellView(view: CommandTranscriptView) {
	return { command: view.command, shell: view.shell, status: view.status, running: view.running, meta: view.meta };
}
