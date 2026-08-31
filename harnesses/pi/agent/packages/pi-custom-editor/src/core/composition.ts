import type {
	EditorBottomTreatment,
	EditorCompositionPreview,
	EditorCompositionStyle,
	EditorRailStyle,
	EditorStatusBandStyle,
	EditorStatusSeparator,
	EditorSurfaceStyle,
	EditorTopTreatment,
} from "pi-libtui/editor";

export const CUSTOM_EDITOR_PRESETS = [
	"claude-code",
	"pi",
	"borderless",
	"top-rule",
	"minimal-field",
	"compact-field",
	"full-field",
	"status-band",
] as const;
export type CustomEditorPreset = (typeof CUSTOM_EDITOR_PRESETS)[number];

export const STATUS_SEGMENTS = [
	"role",
	"provider",
	"model",
	"thinking",
	"fast",
	"path",
	"git",
	"session",
	"working",
	"elapsed",
	"context",
	"context-window",
	"context-qualifier",
	"tokens",
	"cost",
	"clock",
] as const;
export type StatusSegmentId = (typeof STATUS_SEGMENTS)[number];

export const WORKING_PLACEMENTS = [
	"transcript",
	"hidden",
	"top-left-start",
	"top-left-end",
	"top-right-start",
	"top-right-end",
	"bottom-left-start",
	"bottom-left-end",
	"bottom-right-start",
	"bottom-right-end",
] as const;
export type WorkingPlacement = (typeof WORKING_PLACEMENTS)[number];

export const PROMPT_MARKERS = {
	none: [],
	angle: ["⟩"],
	angleDouble: ["⟫"],
	arrowHeavy: ["⮞"],
	triangleFilled: ["▶"],
	triangleOutline: ["▷"],
	angleHeavy: ["⨠"],
	angleWide: ["⪼"],
	chevronOpen: ["❩"],
	chevronLight: ["❫"],
	chevronMedium: ["❭"],
	chevron: ["❯"],
	chevronHeavy: ["❱"],
	nfChevron: [""],
	nfDoubleChevron: [""],
	nfCircle: [""],
	nfTerminal: [""],
	nfPrompt: ["󰔰"],
} as const satisfies Record<string, readonly string[]>;
export type PromptMarkerId = keyof typeof PROMPT_MARKERS;

export interface EditorCompositionSettings {
	readonly preset: CustomEditorPreset;
	readonly surface: "preset" | EditorSurfaceStyle;
	readonly topTreatment: "preset" | EditorTopTreatment;
	readonly bottomTreatment: "preset" | EditorBottomTreatment;
	readonly leftRail: "preset" | EditorRailStyle;
	readonly rightRail: "preset" | EditorRailStyle;
	readonly promptMarker: "preset" | PromptMarkerId;
	readonly footer: "preset" | "off" | "on";
	readonly statusSeparator: "preset" | EditorStatusSeparator;
	readonly statusBand: "preset" | EditorStatusBandStyle;
	readonly railTone: "accent" | "border";
	readonly segmentSource: "preset" | "custom";
	readonly workingPlacement: WorkingPlacement;
	readonly topLeftSegments: readonly StatusSegmentId[];
	readonly topRightSegments: readonly StatusSegmentId[];
	readonly bottomLeftSegments: readonly StatusSegmentId[];
	readonly bottomRightSegments: readonly StatusSegmentId[];
}

export interface ResolvedEditorComposition {
	readonly style: EditorCompositionStyle;
	readonly topLeftSegments: readonly StatusSegmentId[];
	readonly topRightSegments: readonly StatusSegmentId[];
	readonly bottomLeftSegments: readonly StatusSegmentId[];
	readonly bottomRightSegments: readonly StatusSegmentId[];
}

interface PresetDefinition extends EditorCompositionStyle {
	readonly topLeftSegments: readonly StatusSegmentId[];
	readonly topRightSegments: readonly StatusSegmentId[];
	readonly bottomLeftSegments: readonly StatusSegmentId[];
	readonly bottomRightSegments: readonly StatusSegmentId[];
}

const base: PresetDefinition = {
	surface: "editor",
	top: "half-block",
	bottom: "none",
	leftRail: "animated",
	rightRail: "static",
	promptMarker: [],
	promptMarkerMotion: "static",
	bottomStatus: true,
	statusSeparator: "chevron",
	statusBand: "transparent",
	inactiveRailTone: "accent",
	topLeftSegments: [],
	topRightSegments: ["path", "git", "role", "model", "thinking", "fast"],
	bottomLeftSegments: [],
	bottomRightSegments: ["context"],
};

export const EDITOR_PRESETS: Readonly<Record<CustomEditorPreset, PresetDefinition>> = {
	"claude-code": {
		...base,
		surface: "transparent",
		top: "rule",
		bottom: "rule",
		leftRail: "off",
		rightRail: "static",
		promptMarker: ["❯"],
		promptMarkerMotion: "static",
		bottomStatus: false,
		topLeftSegments: ["path", "git", "context"],
		topRightSegments: ["session", "context-window", "clock"],
		bottomLeftSegments: [],
		bottomRightSegments: [],
	},
	pi: {
		...base,
		surface: "transparent",
		top: "rule",
		bottom: "rule",
		leftRail: "off",
		rightRail: "off",
		bottomStatus: true,
		statusSeparator: "dot",
		topLeftSegments: [],
		topRightSegments: [],
		bottomLeftSegments: ["role", "provider", "model", "path", "git", "session"],
		bottomRightSegments: ["context"],
	},
	borderless: {
		...base,
		surface: "transparent",
		top: "none",
		bottom: "none",
		leftRail: "off",
		rightRail: "off",
		promptMarker: ["❯"],
		promptMarkerMotion: "static",
		statusSeparator: "dot",
		topLeftSegments: [],
		topRightSegments: [],
		bottomLeftSegments: ["role", "provider", "model", "path", "git", "session"],
	},
	"top-rule": {
		...base,
		surface: "transparent",
		top: "rule",
		bottom: "none",
		leftRail: "off",
		rightRail: "off",
		promptMarker: ["❯"],
		promptMarkerMotion: "static",
		bottomStatus: false,
		topLeftSegments: ["path", "git"],
		topRightSegments: ["context", "context-window", "clock"],
		bottomLeftSegments: [],
		bottomRightSegments: [],
	},
	"minimal-field": { ...base, top: "none", leftRail: "static", rightRail: "static" },
	"compact-field": base,
	"full-field": { ...base, top: "none", leftRail: "animated", rightRail: "animated" },
	"status-band": {
		...base,
		surface: "transparent",
		top: "status-band",
		leftRail: "off",
		rightRail: "off",
		promptMarker: ["╰─"],
		promptMarkerMotion: "static",
		bottomStatus: false,
		topLeftSegments: ["role", "provider", "model", "path", "git", "session"],
		topRightSegments: ["context", "context-window"],
		bottomLeftSegments: [],
		bottomRightSegments: [],
		statusSeparator: "powerline",
		statusBand: "powerline",
	},
};

function inherited<Value>(value: Value | "preset", fallback: Value): Value {
	return value === "preset" ? fallback : value;
}

export function resolveEditorComposition(settings: EditorCompositionSettings): ResolvedEditorComposition {
	const preset = EDITOR_PRESETS[settings.preset];
	const withoutWorking = (segments: readonly StatusSegmentId[]): StatusSegmentId[] =>
		segments.filter((segment) => segment !== "working");
	const segments = (custom: readonly StatusSegmentId[], fallback: readonly StatusSegmentId[]) =>
		withoutWorking(settings.segmentSource === "custom" ? custom : fallback);
	const topLeftSegments = segments(settings.topLeftSegments, preset.topLeftSegments);
	const topRightSegments = segments(settings.topRightSegments, preset.topRightSegments);
	const bottomLeftSegments = segments(settings.bottomLeftSegments, preset.bottomLeftSegments);
	const bottomRightSegments = segments(settings.bottomRightSegments, preset.bottomRightSegments);
	const placements: Record<Exclude<WorkingPlacement, "transcript" | "hidden">, StatusSegmentId[]> = {
		"top-left-start": topLeftSegments,
		"top-left-end": topLeftSegments,
		"top-right-start": topRightSegments,
		"top-right-end": topRightSegments,
		"bottom-left-start": bottomLeftSegments,
		"bottom-left-end": bottomLeftSegments,
		"bottom-right-start": bottomRightSegments,
		"bottom-right-end": bottomRightSegments,
	};
	if (settings.workingPlacement !== "transcript" && settings.workingPlacement !== "hidden") {
		const target = placements[settings.workingPlacement];
		if (settings.workingPlacement.endsWith("start")) target.unshift("working");
		else target.push("working");
	}
	const footerEnabled = inherited(settings.footer, preset.bottomStatus ? "on" : "off") === "on";
	return {
		style: {
			surface: inherited(settings.surface, preset.surface),
			top: inherited(settings.topTreatment, preset.top),
			bottom: inherited(settings.bottomTreatment, preset.bottom),
			leftRail: inherited(settings.leftRail, preset.leftRail),
			rightRail: inherited(settings.rightRail, preset.rightRail),
			promptMarker: settings.promptMarker === "preset" ? preset.promptMarker : PROMPT_MARKERS[settings.promptMarker],
			promptMarkerMotion: "static",
			bottomStatus: footerEnabled,
			statusSeparator: inherited(settings.statusSeparator, preset.statusSeparator),
			statusBand: inherited(settings.statusBand, preset.statusBand),
			inactiveRailTone: settings.railTone,
		},
		topLeftSegments,
		topRightSegments,
		bottomLeftSegments,
		bottomRightSegments,
	};
}

export function presetPreview(preset: CustomEditorPreset): EditorCompositionPreview {
	return candidatePreview(preset, {});
}

export function candidatePreview(
	preset: CustomEditorPreset,
	overrides: Partial<EditorCompositionStyle>,
): EditorCompositionPreview {
	const style = { ...EDITOR_PRESETS[preset], ...overrides };
	const separator =
		style.statusSeparator === "space"
			? " "
			: style.statusSeparator === "dot"
				? " · "
				: style.statusSeparator === "chevron"
					? " > "
					: "  ";
	const previewSegment: Readonly<Record<StatusSegmentId, string>> = {
		role: "tiny",
		provider: "forge",
		model: "GPT-5.6 Sol",
		thinking: "xhigh",
		fast: "fast",
		path: "~/src/agents",
		git: "next",
		session: "agents",
		working: "Working",
		elapsed: "9:28",
		context: "6.3%/272K",
		"context-window": "272K",
		"context-qualifier": "balanced",
		tokens: "↑8K ↓2K",
		cost: "$0.42",
		clock: "9:28",
	};
	const group = (segments: readonly StatusSegmentId[]) =>
		segments.map((segment) => previewSegment[segment]).join(separator);
	return {
		style,
		topStatus: { left: group(style.topLeftSegments), right: group(style.topRightSegments) },
		bottomStatus: { left: group(style.bottomLeftSegments), right: group(style.bottomRightSegments) },
	};
}
