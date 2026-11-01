import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	activityFrame,
	activityPresentationCadenceMs,
	activityPresentationFrame,
	animationSmoothnessCadenceMs,
	configuredAnimationCadenceMs,
	isTuiActivityIndicatorStyle,
	isTuiActivityMessageStyle,
	isTuiAnimationSmoothness,
	isTuiAnimationSpeed,
	isTuiPulseEffectStyle,
	isTuiStatusPresentationStyle,
	isTuiTextEffectStyle,
	type MotionMount,
	resolveActivityPresentation,
	sharedMotionScheduler,
	getTuiAppearance,
	type SelectBoxRowContext,
	SelectBox,
	type TuiRequestPhase,
	tuiTheme,
} from "@luan.sh/pi-libtui";
import { renderEditorCompositionPreview } from "@luan.sh/pi-libtui/editor";
import type { SettingPreview } from "../protocol/settings.ts";
import type { EnumSettingField } from "./settings-editor.ts";

const previewValidators = {
	"activity-marker": isTuiActivityIndicatorStyle,
	"activity-message": isTuiActivityMessageStyle,
	"status-presentation": isTuiStatusPresentationStyle,
	"text-effect": isTuiTextEffectStyle,
	"pulse-effect": isTuiPulseEffectStyle,
	"animation-speed": isTuiAnimationSpeed,
	"animation-smoothness": isTuiAnimationSmoothness,
} satisfies Record<Exclude<SettingPreview, "editor-composition">, (value: string) => boolean>;

function animationPreview(
	field: Pick<EnumSettingField, "id" | "preview">,
	value: string,
	appearance: ReturnType<typeof getTuiAppearance>,
) {
	const kind = field.preview;
	const indicatorStyle =
		kind === "activity-marker" && isTuiActivityIndicatorStyle(value) ? value : appearance.activityIndicator;
	const messageStyle =
		kind === "activity-message" && isTuiActivityMessageStyle(value) ? value : appearance.activityMessage;
	const presentationStyle =
		kind === "status-presentation" && isTuiStatusPresentationStyle(value) ? value : appearance.statusPresentation;
	const textEffectStyle = kind === "text-effect" && isTuiTextEffectStyle(value) ? value : appearance.textEffect;
	const pulseEffectStyle = kind === "pulse-effect" && isTuiPulseEffectStyle(value) ? value : appearance.pulseEffect;
	const smoothness =
		kind === "animation-smoothness" && isTuiAnimationSmoothness(value) ? value : appearance.animationSmoothness;
	const speed = kind === "animation-speed" && isTuiAnimationSpeed(value) ? value : appearance.animationSpeed;
	const phase: TuiRequestPhase = field.id.includes("thinking")
		? "thinking"
		: field.id.includes("tool")
			? "tool"
			: "working";
	const textEffectScope = appearance.textEffectScope;
	const presentation =
		kind === "activity-message" || kind === "status-presentation"
			? resolveActivityPresentation(
					indicatorStyle,
					messageStyle,
					textEffectStyle,
					textEffectScope,
					pulseEffectStyle,
					presentationStyle,
				)
			: undefined;
	const cadenceMs = presentation
		? activityPresentationCadenceMs(presentation, smoothness, speed)
		: configuredAnimationCadenceMs(indicatorStyle, textEffectStyle, smoothness, speed, pulseEffectStyle);
	return {
		kind,
		phase,
		indicatorStyle,
		textEffectStyle,
		pulseEffectStyle,
		textEffectScope,
		smoothness,
		speed,
		presentation,
		cadenceMs,
	};
}

function renderAnimationOption(
	preview: ReturnType<typeof animationPreview>,
	label: string,
	context: SelectBoxRowContext,
	elapsedMs: number,
): string {
	if (context.query) return context.highlight(label);
	const colors = tuiTheme(context.theme);
	const {
		kind,
		phase,
		indicatorStyle,
		textEffectStyle,
		pulseEffectStyle,
		textEffectScope,
		smoothness,
		speed,
		presentation,
	} = preview;
	let rendered: string;
	if (presentation) {
		const lineWidth = Math.max(10, Math.min(32, context.width - label.length - 3));
		const frame = activityPresentationFrame(colors, presentation, phase, label, elapsedMs, lineWidth, {
			animationSpeed: speed,
			animationSmoothness: smoothness,
		});
		const animated = frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
		rendered =
			presentation.kind === "inline" && presentation.messageStyle === "phase" ? animated : `${animated}  ${label}`;
	} else {
		const cadenceMs = preview.cadenceMs ?? animationSmoothnessCadenceMs(smoothness);
		const frame = activityFrame(
			colors,
			kind === "text-effect" ? "Working..." : label,
			kind === "animation-smoothness" ? Math.floor(elapsedMs / cadenceMs) * cadenceMs : elapsedMs,
			{
				indicatorStyle,
				textEffectStyle,
				pulseEffectStyle,
				textEffectScope,
				animationSpeed: speed,
				textTone: context.selected ? "accent" : "text.primary",
			},
		);
		const animated = frame.marker ? `${frame.marker} ${frame.text}` : frame.text;
		rendered = kind === "text-effect" ? `${animated}  ${label}` : animated;
	}
	return context.selected ? context.theme.bold(rendered) : rendered;
}

export class AnimationSelect extends SelectBox<string> {
	private readonly motion?: MotionMount;

	constructor(
		field: EnumSettingField,
		theme: Theme,
		done: (value?: string) => void,
		preview: (value: string) => void,
		requestRender: () => void,
	) {
		let now = performance.now();
		const startedAt = now;
		const validate =
			field.preview && field.preview !== "editor-composition" ? previewValidators[field.preview] : undefined;
		const options = field.options.filter(
			(option) => validate && (option.value === "inherit" || validate(option.value)),
		);
		const appearance = getTuiAppearance();
		const previews = new Map(
			options.map((option) => [option.value, animationPreview(field, option.value, appearance)]),
		);
		super({
			bordered: false,
			options,
			selected: options.some((option) => option.value === field.value) ? field.value : undefined,
			theme,
			onSelect: done,
			onPreview: preview,
			onCancel: () => done(),
			requestRender,
			renderOption: (option, context) =>
				renderAnimationOption(previews.get(option.value)!, option.label, context, now - startedAt),
		});
		const cadences = [...previews.values()].flatMap(({ cadenceMs }) => (cadenceMs === undefined ? [] : [cadenceMs]));
		if (cadences.length > 0) {
			this.motion = sharedMotionScheduler.mount(
				{ requestRender },
				{
					cadenceMs: Math.min(...cadences),
					onFrame: (next) => {
						now = next;
					},
				},
			);
		}
	}

	dispose(): void {
		this.motion?.dispose();
	}
}

export class EditorCompositionSelect extends SelectBox<string> {
	private readonly motion: MotionMount;

	constructor(
		field: EnumSettingField,
		theme: Theme,
		done: (value?: string) => void,
		preview: (value: string) => void,
		requestRender: () => void,
	) {
		let now = performance.now();
		const startedAt = now;
		const options = field.options.filter((option) => option.preview !== undefined);
		super({
			theme,
			title: field.label,
			bordered: false,
			showHint: true,
			options,
			selected: options.some((option) => option.value === field.value) ? field.value : undefined,
			onSelect: done,
			onPreview: preview,
			onCancel: () => done(),
			requestRender,
			renderOption: (option, context) => {
				const label = context.highlight(option.label);
				return context.selected ? theme.bold(label) : label;
			},
			renderPreview: (option, width) => {
				const preview = options.find((candidate) => candidate.value === option.value)?.preview;
				return preview ? renderEditorCompositionPreview(theme, preview, width, now - startedAt) : [];
			},
		});
		this.motion = sharedMotionScheduler.mount(
			{ requestRender },
			{
				cadenceMs: animationSmoothnessCadenceMs(getTuiAppearance().animationSmoothness),
				onFrame: (next) => {
					now = next;
				},
			},
		);
	}

	dispose(): void {
		this.motion.dispose();
	}
}
