import { createSettings, type SettingDefinitionInput, type SettingsOf } from "pi-xsettings/sdk";
import {
	CUSTOM_EDITOR_PRESETS,
	candidatePreview,
	PROMPT_MARKERS,
	presetPreview,
	STATUS_SEGMENTS,
	WORKING_PLACEMENTS,
} from "../core/composition.ts";

const previewPreset = "compact-field" as const;
const inherited = { value: "preset", label: "Preset", description: "Use the selected preset's value." } as const;
const option = <Value extends string>(value: Value, label: string, description: string) => ({
	value,
	label,
	description,
});
const previewOption = <Value extends string>(
	value: Value,
	label: string,
	description: string,
	overrides: Parameters<typeof candidatePreview>[1],
) => ({ value, label, description, preview: candidatePreview(previewPreset, overrides) });
const workingPlacementOption = (value: (typeof WORKING_PLACEMENTS)[number]) => {
	return {
		value,
		label:
			value === "transcript"
				? "Transcript (Pi default)"
				: value === "hidden"
					? "Hidden"
					: value
							.split("-")
							.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
							.join(" "),
		description:
			value === "transcript"
				? "Use Pi's native working row in the transcript."
				: value === "hidden"
					? "Hide the working animation."
					: `Place the shared Working animation at ${value.replaceAll("-", " ")}.`,
	};
};

const markerLabels: Readonly<Record<keyof typeof PROMPT_MARKERS, string>> = {
	none: "None",
	angle: "⟩",
	angleDouble: "⟫",
	arrowHeavy: "⮞",
	triangleFilled: "▶",
	triangleOutline: "▷",
	angleHeavy: "⨠",
	angleWide: "⪼",
	chevronOpen: "❩",
	chevronLight: "❫",
	chevronMedium: "❭",
	chevron: "❯",
	chevronHeavy: "❱",
	nfChevron: "",
	nfDoubleChevron: "",
	nfCircle: "",
	nfTerminal: "",
	nfPrompt: "󰔰",
};

const definitions = {
	preset: {
		category: "appearance",
		page: "editor",
		section: "Editor layout",
		label: "Preset",
		description: "Choose a complete editor composition; explicit controls below override it.",
		type: "enum",
		default: "compact-field",
		preview: "editor-composition",
		options: CUSTOM_EDITOR_PRESETS.map((value) => ({
			value,
			label: value
				.split("-")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" "),
			description: `Use the ${value.replaceAll("-", " ")} composition.`,
			preview: presetPreview(value),
		})),
	},
	surface: {
		category: "appearance",
		page: "editor",
		section: "Editor surface",
		label: "Surface",
		description: "Choose the semantic background painted behind input rows.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("transparent", "Transparent", "Inherit the terminal background.", { surface: "transparent" }),
			previewOption("base", "Base", "Paint the theme base background.", { surface: "base" }),
			previewOption("editor", "Editor", "Use the semantic editor surface.", { surface: "editor" }),
			previewOption("raised", "Raised", "Use an elevated surface.", { surface: "raised" }),
			previewOption("inset", "Inset", "Use a recessed surface.", { surface: "inset" }),
			previewOption("accent", "Accent wash", "Use a subtle theme-derived accent wash.", { surface: "accent" }),
		],
	},
	topTreatment: {
		category: "appearance",
		page: "editor",
		section: "Editor layout",
		label: "Top treatment",
		description: "Choose the chrome immediately above the prompt.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("none", "Plain", "Show top segments without surrounding chrome.", { top: "none" }),
			previewOption("half-block", "Half-block ramp", "Use the compact half-height surface transition.", {
				top: "half-block",
			}),
			previewOption("rule", "Rule", "Embed the top-left and top-right segments in a horizontal rule.", {
				top: "rule",
			}),
			previewOption("status-band", "Status band", "Render a status band above the prompt.", {
				top: "status-band",
				statusBand: "powerline",
			}),
		],
	},
	bottomTreatment: {
		category: "appearance",
		page: "editor",
		section: "Editor layout",
		label: "Bottom treatment",
		description: "Choose the chrome immediately below the prompt.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("none", "None", "Do not draw a bottom edge.", { bottom: "none" }),
			previewOption("rule", "Rule", "Draw a full horizontal rule.", { bottom: "rule" }),
		],
	},
	leftRail: {
		category: "appearance",
		page: "editor",
		section: "Editor surface",
		label: "Left rail",
		description: "Control the left field rail independently.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("off", "Off", "Hide the left rail.", { leftRail: "off" }),
			previewOption("static", "Static", "Show a steady left rail.", { leftRail: "static" }),
			previewOption("animated", "Animated", "Pulse the left rail while working.", { leftRail: "animated" }),
		],
	},
	rightRail: {
		category: "appearance",
		page: "editor",
		section: "Editor surface",
		label: "Right rail",
		description: "Control the right field rail independently.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("off", "Off", "Hide the right rail.", { rightRail: "off" }),
			previewOption("static", "Static", "Show a steady right rail.", { rightRail: "static" }),
			previewOption("animated", "Animated", "Pulse the right rail while working.", { rightRail: "animated" }),
		],
	},
	promptMarker: {
		category: "appearance",
		page: "editor",
		section: "Editor surface",
		label: "Prompt marker",
		description: "Choose a static Unicode or Nerd Font prompt marker.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			...(Object.keys(PROMPT_MARKERS) as Array<keyof typeof PROMPT_MARKERS>).map((value) => ({
				value,
				label: markerLabels[value],
				description: "Static prompt marker.",
				preview: candidatePreview(previewPreset, { promptMarker: PROMPT_MARKERS[value], promptMarkerMotion: "static" }),
			})),
		],
	},
	railTone: {
		category: "appearance",
		page: "editor",
		section: "Editor surface",
		label: "Inactive rail tone",
		description: "Choose the semantic color used by rails at rest.",
		type: "enum",
		default: "accent",
		preview: "editor-composition",
		options: [
			previewOption("accent", "Accent", "Use the theme accent.", {
				leftRail: "static",
				rightRail: "static",
				inactiveRailTone: "accent",
			}),
			previewOption("border", "Border", "Use the subdued border tone.", {
				leftRail: "static",
				rightRail: "static",
				inactiveRailTone: "border",
			}),
		],
	},
	footer: {
		category: "appearance",
		page: "editor",
		section: "Status layout",
		label: "Bottom status row",
		description: "Show the bottom-left and bottom-right segment groups independently of the bottom rule.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("off", "Off", "Hide the bottom quadrants without changing the bottom rule.", {
				bottomStatus: false,
			}),
			previewOption("on", "On", "Show the bottom-left and bottom-right quadrants.", { bottomStatus: true }),
		],
	},
	segmentSource: {
		category: "appearance",
		page: "editor",
		section: "Status layout",
		label: "Segment source",
		description: "Use the preset's four quadrants or customize every quadrant below.",
		type: "enum",
		default: "preset",
		options: [
			option("preset", "Preset", "Use the selected preset's quadrants."),
			option("custom", "Custom", "Use all four ordered quadrant lists below."),
		],
	},
	workingPlacement: {
		category: "appearance",
		page: "editor",
		section: "Status layout",
		label: "Working placement",
		description: "Place the existing Animations → Working presentation; Transcript uses Pi's default row.",
		type: "enum",
		default: "transcript",
		options: WORKING_PLACEMENTS.map(workingPlacementOption),
	},
	topLeftSegments: {
		category: "appearance",
		page: "editor",
		section: "Top left",
		label: "Segments",
		description: "Choose and order segments in the top-left quadrant.",
		type: "multi-enum",
		ordered: true,
		default: [],
		options: STATUS_SEGMENTS.filter((value) => value !== "working").map((value) =>
			option(value, value.replaceAll("-", " "), `Show ${value.replaceAll("-", " ")}.`),
		),
	},
	topRightSegments: {
		category: "appearance",
		page: "editor",
		section: "Top right",
		label: "Segments",
		description: "Choose and order segments in the top-right quadrant.",
		type: "multi-enum",
		ordered: true,
		default: ["path", "git", "role", "model", "thinking", "fast"],
		options: STATUS_SEGMENTS.filter((value) => value !== "working").map((value) =>
			option(value, value.replaceAll("-", " "), `Show ${value.replaceAll("-", " ")}.`),
		),
	},
	bottomLeftSegments: {
		category: "appearance",
		page: "editor",
		section: "Bottom left",
		label: "Segments",
		description: "Choose and order segments in the bottom-left quadrant.",
		type: "multi-enum",
		ordered: true,
		default: [],
		options: STATUS_SEGMENTS.filter((value) => value !== "working").map((value) =>
			option(value, value.replaceAll("-", " "), `Show ${value.replaceAll("-", " ")}.`),
		),
	},
	bottomRightSegments: {
		category: "appearance",
		page: "editor",
		section: "Bottom right",
		label: "Segments",
		description: "Choose and order segments in the bottom-right quadrant.",
		type: "multi-enum",
		ordered: true,
		default: ["context"],
		options: STATUS_SEGMENTS.filter((value) => value !== "working").map((value) =>
			option(value, value.replaceAll("-", " "), `Show ${value.replaceAll("-", " ")}.`),
		),
	},
	statusSeparator: {
		category: "appearance",
		page: "editor",
		section: "Status layout",
		label: "Status separator",
		description: "Choose the separator between status segments.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("space", "Space", "Separate segments with spacing.", { statusSeparator: "space" }),
			previewOption("dot", "Dot", "Separate segments with a centered dot.", { statusSeparator: "dot" }),
			previewOption("chevron", "Chevron", "Separate segments with a chevron.", { statusSeparator: "chevron" }),
			previewOption("powerline", "Powerline", "Separate segments with Powerline glyphs.", {
				statusSeparator: "powerline",
			}),
		],
	},
	statusBand: {
		category: "appearance",
		page: "editor",
		section: "Status layout",
		label: "Status band style",
		description: "Choose the surface used by standalone status rows.",
		type: "enum",
		default: "preset",
		preview: "editor-composition",
		options: [
			{ ...inherited, preview: presetPreview(previewPreset) },
			previewOption("transparent", "Transparent", "Use no status background.", { statusBand: "transparent" }),
			previewOption("filled", "Filled", "Paint a semantic raised band.", { statusBand: "filled" }),
			previewOption("powerline", "Powerline", "Render left and right status pills.", { statusBand: "powerline" }),
		],
	},
} as const satisfies Record<string, SettingDefinitionInput>;

const settings = createSettings({ namespace: "pi-custom-editor", label: "Custom Editor", apply: "live", definitions });

export type CustomEditorSettings = SettingsOf<typeof definitions>;
export const DEFAULT_CUSTOM_EDITOR_SETTINGS: CustomEditorSettings = { ...settings.defaults };
export const getCustomEditorSettings = settings.get;
export const registerCustomEditorSettings = settings.register;
