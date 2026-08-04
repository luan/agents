import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansiFgToRgb } from "../shared/tui";

const RESET = "\x1b[0m";
const RESET_ANSI = /\x1b\[0m/g;
const EDITOR_BACKGROUND_DARKEN = 0.78;
// Block Elements, like the half row it grows out of: the geometric-shape triangles are
// East-Asian-ambiguous and get drawn double width, which shifts every column after them.
const TRANSITION_RAMP = "▟";

type Rgb = [number, number, number];

function backgroundAnsi(uiTheme: Theme): string | undefined {
	return uiTheme.getBgAnsi?.("customMessageBg") ?? uiTheme.bg("customMessageBg", " ").split(" ")[0];
}

// Called once per editor line per frame, and parsing the escape is pure string work.
// Keyed on the escape itself, so a theme change simply produces a different key.
const backgroundRgbCache = new Map<string, Rgb | undefined>();

function backgroundRgb(uiTheme: Theme): Rgb | undefined {
	const ansi = backgroundAnsi(uiTheme);
	if (ansi === undefined) return undefined;
	if (backgroundRgbCache.has(ansi)) return backgroundRgbCache.get(ansi);
	const rgb = ansiFgToRgb(ansi.replace("\x1b[48", "\x1b[38"));
	backgroundRgbCache.set(ansi, rgb);
	return rgb;
}

function isLight(rgb: Rgb): boolean {
	return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 >= 160;
}

function darken(rgb: Rgb): Rgb {
	return rgb.map((value) => Math.round(value * EDITOR_BACKGROUND_DARKEN)) as Rgb;
}

function paintBackground(content: string, background: Rgb): string {
	const backgroundAnsi = `\x1b[48;2;${background[0]};${background[1]};${background[2]}m`;
	return `${backgroundAnsi}${content.replace(RESET_ANSI, `${RESET}${backgroundAnsi}`)}\x1b[49m`;
}

export function fillEditorLine(uiTheme: Theme, content: string, width: number): string {
	const rgb = backgroundRgb(uiTheme);
	if (!rgb || isLight(rgb)) return fillLine(content, width);
	return paintBackground(fillLine(content, width), darken(rgb));
}

// The transition row is half height: the editor background rises to meet the transcript. A
// trailing block grows it to full height for its own columns, ramping up over one diagonal cell.
export function fillEditorTransitionLine(uiTheme: Theme, leading: string, width: number, trailing = ""): string {
	const block = trailing ? ` ${trailing}` : "";
	const blockWidth = visibleWidth(block);
	const rampWidth = block ? 1 : 0;
	const halfWidth = Math.max(0, width - visibleWidth(leading) - blockWidth - rampWidth);

	const rgb = backgroundRgb(uiTheme);
	if (!rgb || isLight(rgb)) return fillLine(`${leading}${" ".repeat(halfWidth + rampWidth)}${block}`, width);

	const background = darken(rgb);
	const half = `\x1b[38;2;${background[0]};${background[1]};${background[2]}m${"▄".repeat(halfWidth)}${TRANSITION_RAMP.repeat(rampWidth)}\x1b[39m`;
	return `${leading}${half}${block ? paintBackground(block, background) : ""}`;
}

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "");
	const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${spaces}`;
}

export const ANSI_RESET = RESET;
