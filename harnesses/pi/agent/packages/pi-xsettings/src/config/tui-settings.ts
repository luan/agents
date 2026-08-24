import { configureTuiAppearance } from "pi-libtui";
import { createSettings } from "../sdk.ts";

export const tuiSettings = createSettings({
	namespace: "pi-libtui",
	label: "TUI",
	definitions: {
		iconPack: {
			category: "appearance",
			section: "Style",
			label: "Icon pack",
			description: "Icon set used by shared TUI components.",
			type: "enum",
			default: "unicode",
			options: [
				{ value: "nerd-fonts", label: "Nerd Fonts", description: "Patched-font icons." },
				{ value: "unicode", label: "Unicode", description: "Plain text Unicode symbols." },
				{ value: "emoji", label: "Emoji", description: "Color emoji symbols." },
			],
		},
		powerline: {
			category: "appearance",
			section: "Style",
			label: "Powerline separators",
			description: "Use rounded Powerline separators where supported.",
			type: "boolean",
			default: false,
		},
		powerlineButtons: {
			category: "appearance",
			section: "Style",
			label: "Powerline buttons",
			description: "Use rounded Powerline caps for buttons.",
			type: "boolean",
			default: false,
		},
		softCursor: {
			category: "appearance",
			section: "Style",
			label: "Softer virtual cursor",
			description: "Use a muted surface for virtual editor cursors.",
			type: "boolean",
			default: false,
		},
		insertionCursor: {
			category: "appearance",
			page: "terminal",
			section: "Cursor",
			label: "Insertion cursor",
			description: "Cursor used while editing text.",
			type: "enum",
			default: "virtual",
			options: cursorOptions(),
		},
		navigationCursor: {
			category: "appearance",
			page: "terminal",
			section: "Cursor",
			label: "Navigation cursor",
			description: "Cursor used while navigating without a selection.",
			type: "enum",
			default: "virtual",
			options: cursorOptions(),
		},
		selectionCursor: {
			category: "appearance",
			page: "terminal",
			section: "Cursor",
			label: "Selection cursor",
			description: "Cursor used at the active end of a selection.",
			type: "enum",
			default: "virtual",
			options: cursorOptions(),
		},
	},
});

function cursorOptions() {
	return [
		{ value: "virtual", label: "Virtual", description: "Paint the cursor into the TUI." },
		{ value: "terminal-default", label: "Terminal default", description: "Use the terminal's default cursor." },
		{ value: "blinking-block", label: "Blinking block", description: "Use a blinking block cursor." },
		{ value: "steady-block", label: "Steady block", description: "Use a steady block cursor." },
		{ value: "blinking-underline", label: "Blinking underline", description: "Use a blinking underline cursor." },
		{ value: "steady-underline", label: "Steady underline", description: "Use a steady underline cursor." },
		{ value: "blinking-bar", label: "Blinking bar", description: "Use a blinking bar cursor." },
		{ value: "steady-bar", label: "Steady bar", description: "Use a steady bar cursor." },
	] as const;
}

export function registerTuiSettings(): () => void {
	return tuiSettings.register((settings) => configureTuiAppearance(settings));
}
