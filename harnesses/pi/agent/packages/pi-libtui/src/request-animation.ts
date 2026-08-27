import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getTuiAppearance, requestPhaseAnimation, subscribeTuiAppearance, type TuiRequestPhase } from "./appearance.ts";
import { activityPresentationCadenceMs, activityPresentationFrame } from "./activity-presentation.ts";
import { tuiTheme } from "./color/theme.ts";
import { type MotionMount, type MotionScheduler, sharedMotionScheduler } from "./motion.ts";

type RequestAnimationUi = Pick<ExtensionContext["ui"], "setWorkingIndicator" | "setWorkingMessage" | "theme">;

interface RequestAnimationContext {
	ui: RequestAnimationUi;
}

interface RequestAnimationControllerOptions {
	now?: () => number;
	scheduler?: MotionScheduler;
	width?: () => number;
}

/** Owns Pi's streaming status animation across thinking, working, and tool phases. */
export class RequestAnimationController {
	private readonly activeTools = new Set<string>();
	private readonly now: () => number;
	private readonly scheduler: MotionScheduler;
	private readonly unsubscribeAppearance: () => void;
	private readonly width: () => number;
	private context?: RequestAnimationContext;
	private mount?: MotionMount;
	private phase?: TuiRequestPhase;
	private phaseStartedAt = 0;
	private thinking = false;

	constructor(options: RequestAnimationControllerOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.scheduler = options.scheduler ?? sharedMotionScheduler;
		this.width = options.width ?? (() => Math.max(10, (process.stdout.columns || 80) - 4));
		this.unsubscribeAppearance = subscribeTuiAppearance(() => {
			if (!this.context) return;
			this.remount();
			this.render();
		});
	}

	start(context: RequestAnimationContext): void {
		this.stop();
		this.context = context;
		this.phase = "working";
		this.phaseStartedAt = this.now();
		context.ui.setWorkingIndicator({ frames: [] });
		this.remount();
		this.render();
	}

	finish(context?: RequestAnimationContext): void {
		this.stop(context);
	}

	setThinking(active: boolean): void {
		if (this.thinking === active) return;
		this.thinking = active;
		this.syncPhase();
	}

	startTool(toolCallId: string): void {
		const before = this.activeTools.size;
		this.activeTools.add(toolCallId);
		if (this.activeTools.size !== before) this.syncPhase();
	}

	finishTool(toolCallId: string): void {
		if (!this.activeTools.delete(toolCallId)) return;
		this.syncPhase();
	}

	dispose(context?: RequestAnimationContext): void {
		this.stop(context);
		this.unsubscribeAppearance();
	}

	private stop(context?: RequestAnimationContext): void {
		const ui = context?.ui ?? this.context?.ui;
		this.mount?.dispose();
		this.mount = undefined;
		this.context = undefined;
		this.phase = undefined;
		this.thinking = false;
		this.activeTools.clear();
		if (!ui) return;
		ui.setWorkingMessage();
		ui.setWorkingIndicator();
	}

	private syncPhase(): void {
		if (!this.context) return;
		const next: TuiRequestPhase = this.thinking ? "thinking" : this.activeTools.size > 0 ? "tool" : "working";
		if (next === this.phase) return;
		this.phase = next;
		this.phaseStartedAt = this.now();
		this.remount();
		this.render();
	}

	private remount(): void {
		this.mount?.dispose();
		this.mount = undefined;
		if (!this.context || !this.phase) return;
		const appearance = getTuiAppearance();
		const presentation = requestPhaseAnimation(this.phase, appearance);
		const cadenceMs = activityPresentationCadenceMs(
			presentation,
			appearance.animationSmoothness,
			appearance.animationSpeed,
		);
		if (cadenceMs === undefined) return;
		this.mount = this.scheduler.mount({ requestRender: () => this.render() }, { cadenceMs });
	}

	private render(): void {
		if (!this.context || !this.phase) return;
		const appearance = getTuiAppearance();
		const presentation = requestPhaseAnimation(this.phase, appearance);
		const frame = activityPresentationFrame(
			tuiTheme(this.context.ui.theme),
			presentation,
			this.phase,
			phaseLabel(this.phase),
			this.now() - this.phaseStartedAt,
			this.width(),
			{
				animationSpeed: appearance.animationSpeed,
				animationSmoothness: appearance.animationSmoothness,
			},
		);
		this.context.ui.setWorkingMessage(frame.marker ? `${frame.marker} ${frame.text}` : frame.text);
	}
}

function phaseLabel(phase: TuiRequestPhase): string {
	return phase === "thinking" ? "Thinking..." : phase === "tool" ? "Running..." : "Working...";
}

/** Bind the shared request animation to Pi's public lifecycle and status APIs. */
export function registerRequestAnimation(pi: ExtensionAPI): RequestAnimationController {
	const controller = new RequestAnimationController();
	pi.on("agent_start", (_event, context) => controller.start(context));
	pi.on("agent_end", (_event, context) => controller.finish(context));
	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_start" || type === "thinking_delta") controller.setThinking(true);
		if (type === "thinking_end" || type === "text_start" || type === "text_delta") controller.setThinking(false);
	});
	pi.on("message_end", () => controller.setThinking(false));
	pi.on("tool_execution_start", (event) => controller.startTool(event.toolCallId));
	pi.on("tool_execution_end", (event) => controller.finishTool(event.toolCallId));
	pi.on("session_before_switch", (_event, context) => controller.finish(context));
	pi.on("session_shutdown", (_event, context) => controller.dispose(context));
	return controller;
}
