import { statusPresentationFrame, activityMessageFrame } from "./status-presentation.ts";
import type {
	TuiActivityPresentation,
	TuiAnimationSmoothness,
	TuiAnimationSpeed,
	TuiRequestPhase,
} from "./appearance.ts";
import type { TuiTheme } from "./color/theme.ts";
import {
	activityFrame,
	animationSmoothnessCadenceMs,
	configuredAnimationCadenceMs,
	type ActivityFrame,
} from "./motion.ts";

export interface ActivityPresentationOptions {
	animationSpeed?: TuiAnimationSpeed;
	animationSmoothness?: TuiAnimationSmoothness;
	reducedMotion?: boolean;
}

/** Render an inline activity composition or one exclusive status presentation. */
export function activityPresentationFrame(
	colors: TuiTheme,
	presentation: TuiActivityPresentation,
	phase: TuiRequestPhase,
	phaseLabel: string,
	elapsedMs: number,
	width: number,
	options: ActivityPresentationOptions = {},
): ActivityFrame {
	if (presentation.kind === "inline") {
		const text =
			presentation.messageStyle === "phase"
				? phaseLabel
				: activityMessageFrame(elapsedMs, {
						animationSpeed: options.animationSpeed,
						reducedMotion: options.reducedMotion,
					});
		return activityFrame(colors, text, elapsedMs, {
			indicatorStyle: presentation.indicatorStyle,
			textEffectStyle: presentation.textEffectStyle,
			textEffectScope: presentation.textEffectScope,
			pulseEffectStyle: presentation.pulseEffectStyle,
			animationSpeed: options.animationSpeed,
			animationSmoothness: options.animationSmoothness,
			reducedMotion: options.reducedMotion,
		});
	}
	return {
		marker: "",
		text: statusPresentationFrame(colors, presentation.style, elapsedMs, width, {
			animationSpeed: options.animationSpeed,
			phase,
			reducedMotion: options.reducedMotion,
		}),
	};
}

/** Resolve the repaint cadence from the same presentation plan used to render frames. */
export function activityPresentationCadenceMs(
	presentation: TuiActivityPresentation,
	smoothness: TuiAnimationSmoothness,
	speed: TuiAnimationSpeed,
): number | undefined {
	return presentation.kind === "inline"
		? configuredAnimationCadenceMs(
				presentation.indicatorStyle,
				presentation.textEffectStyle,
				smoothness,
				speed,
				presentation.pulseEffectStyle,
			)
		: animationSmoothnessCadenceMs(smoothness);
}
