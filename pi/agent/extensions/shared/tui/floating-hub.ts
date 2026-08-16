import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type FloatingHubTheme = {
	fg(role: string, text: string): string;
	bold?(text: string): string;
};

export const FLOATING_HUB_OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "95%" as const,
	maxHeight: "95%" as const,
};

export const FLOATING_HUB_CHROME_ROWS = 7;

export function floatingHubHeight(terminalRows: number): number {
	return Math.max(FLOATING_HUB_CHROME_ROWS + 1, Math.floor(terminalRows * 0.9));
}

export function floatingHubInnerWidth(width: number): number {
	return Math.max(0, width - 4);
}

export function floatingHubRow(theme: FloatingHubTheme, content: string, innerWidth: number): string {
	const clipped = truncateToWidth(content, innerWidth, "");
	const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${theme.fg("border", "│")} ${padded} ${theme.fg("border", "│")}`;
}

export function floatingHubSeparator(theme: FloatingHubTheme, innerWidth: number): string {
	return floatingHubRow(theme, theme.fg("dim", "─".repeat(innerWidth)), innerWidth);
}

export function floatingHubBorderTop(theme: FloatingHubTheme, width: number): string {
	return theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
}

export function floatingHubBorderBottom(theme: FloatingHubTheme, width: number): string {
	return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

export function floatingHubBold(theme: FloatingHubTheme, text: string): string {
	return theme.bold?.(text) ?? text;
}
