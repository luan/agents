import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RESET = "\x1b[0m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export interface PadToVisibleWidthOptions {
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

export function paintAnsiBackgroundRow(line: string, width: number, backgroundAnsi: string | undefined): string {
	const padded = truncateToWidth(line, width, "", true);
	if (!backgroundAnsi) return padded;
	return `${backgroundAnsi}${keepBackgroundAcrossResets(padded, backgroundAnsi)}${ANSI_RESET}`;
}

export function clampAnsiLine(line: string, width: number): string {
	return truncateToWidth(line.replace(OSC_SEQUENCE_PATTERN, ""), width, "", true);
}

export function padToVisibleWidth(text: string, width: number, options: PadToVisibleWidthOptions = {}): string {
	const rendered =
		options.truncate === false
			? text
			: truncateToWidth(text, width, options.ellipsis ?? "…", options.preserveAnsi ?? false);
	return `${rendered}${" ".repeat(Math.max(0, width - visibleWidth(rendered)))}`;
}
