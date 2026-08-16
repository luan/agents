import { truncateToWidth as truncateToWidthRaw, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RESET = "\x1b[0m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const OSC133_PREFIX = /^(?:\x1b]133;[ABC]\x07)*/;
const ANSI_BACKGROUND = /\x1b\[48(?:;[0-9]+)*m/;

let stringEllipsisSupported: boolean | undefined;

/**
 * Italic, as a span that closes itself.
 *
 * `\x1b[23m` rather than a full reset: an italic run is nested inside a colour
 * more often than it wraps one, and resetting here would drop the colour the
 * caller opened for the rest of its line.
 */
export function italic(text: string): string {
	return `\x1b[3m${text}\x1b[23m`;
}

/** Faint intensity without changing the surrounding foreground colour. */
export function faint(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

export function truncateToWidthCompat(text: string, width: number, ellipsis: string | undefined, pad = false): string {
	if (!ellipsis || ellipsis === "" || stringEllipsisSupported === false) {
		return truncateToWidthRaw(text, width, ellipsis === "" ? "" : undefined, pad);
	}
	try {
		const result = truncateToWidthRaw(text, width, ellipsis, pad);
		stringEllipsisSupported = true;
		return result;
	} catch {
		stringEllipsisSupported = false;
		return truncateToWidthRaw(text, width, undefined, pad);
	}
}

interface PadToVisibleWidthOptions {
	truncate?: boolean;
	ellipsis?: string;
	preserveAnsi?: boolean;
}

export function sgrResetsBackground(rawParams: string): boolean {
	if (rawParams.trim() === "") return true;
	return rawParams
		.split(";")
		.map((param) => Number.parseInt(param, 10))
		.some((param) => param === 0 || param === 49);
}

export function keepBackgroundAcrossResets(text: string, backgroundAnsi: string): string {
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		if (!sgrResetsBackground(rawParams)) return sequence;
		return `${sequence}${backgroundAnsi}`;
	});
}

type SgrBackgroundEffect = "sets" | "clears" | "other";

/**
 * What an SGR sequence does to the background colour.
 *
 * Parsed rather than pattern-matched because `38`/`48` swallow their arguments:
 * in `38;5;2` the `2` is a palette index, not "faint", and reading it as a
 * parameter would misclassify the sequence.
 */
function sgrBackgroundEffect(rawParams: string): SgrBackgroundEffect {
	if (rawParams.trim() === "") return "clears";
	const params = rawParams.split(";").map((param) => (param === "" ? 0 : Number.parseInt(param, 10)));
	let effect: SgrBackgroundEffect = "other";
	for (let index = 0; index < params.length; index++) {
		const param = params[index]!;
		if (param === 38 || param === 48) {
			if (param === 48) effect = "sets";
			const mode = params[index + 1];
			index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
			continue;
		}
		if (param === 0 || param === 49) effect = "clears";
		else if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) effect = "sets";
	}
	return effect;
}

/**
 * Re-apply the row background after style changes that would lose it, and only
 * those.
 *
 * Re-applying after every SGR also overwrote backgrounds the line set for
 * itself, which is how diff rows lost their added/removed bands: the row
 * painted green, the next foreground change stamped the card colour back over
 * it. A line that owns a background keeps it until it clears it.
 */
function keepBackgroundAcrossStyles(text: string, backgroundAnsi: string): string {
	let lineOwnsBackground = false;
	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const effect = sgrBackgroundEffect(rawParams);
		if (effect === "sets") {
			lineOwnsBackground = true;
			return sequence;
		}
		if (effect === "clears") {
			lineOwnsBackground = false;
			return `${sequence}${backgroundAnsi}`;
		}
		return lineOwnsBackground ? sequence : `${sequence}${backgroundAnsi}`;
	});
}

export function paintAnsiBackgroundRow(line: string, width: number, backgroundAnsi: string | undefined): string {
	const padded = truncateToWidthCompat(line, width, "", true);
	if (!backgroundAnsi) return padded;
	return `${backgroundAnsi}${keepBackgroundAcrossStyles(padded, backgroundAnsi)}${ANSI_RESET}`;
}

export function paintHalfHeightBackgroundRow(line: string, glyph: "▄" | "▀", width: number): string {
	const background = line.match(ANSI_BACKGROUND)?.[0];
	if (!background) return line;
	const prefix = line.match(OSC133_PREFIX)?.[0] ?? "";
	return `${prefix}${background.replace("[48", "[38")}${glyph.repeat(width)}\x1b[39m`;
}

export function paintHalfHeightBackgroundEdges(lines: string[], width: number): string[] {
	if (lines.length < 2) return lines;
	lines[0] = paintHalfHeightBackgroundRow(lines[0] ?? "", "▄", width);
	lines[lines.length - 1] = paintHalfHeightBackgroundRow(lines.at(-1) ?? "", "▀", width);
	return lines;
}

export function clampAnsiLine(line: string, width: number): string {
	return truncateToWidthCompat(line.replace(OSC_SEQUENCE_PATTERN, ""), width, "", true);
}

export function padToVisibleWidth(text: string, width: number, options: PadToVisibleWidthOptions = {}): string {
	const rendered =
		options.truncate === false
			? text
			: truncateToWidthCompat(text, width, options.ellipsis ?? "…", options.preserveAnsi ?? false);
	return `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
}
