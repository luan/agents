import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ESCAPE_PATTERN = "\\x1B";
const RESET_ANSI = new RegExp(`${ESCAPE_PATTERN}\\[0m`, "g");
const RESET = "\x1b[0m";

export function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "");
	const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${spaces}`;
}

export function fillBackgroundLine(uiTheme: Theme, content: string, width: number): string {
	const filled = fillLine(content, width);
	const sample = uiTheme.bg("customMessageBg", " ");
	const spaceIndex = sample.indexOf(" ");
	if (spaceIndex < 0) return uiTheme.bg("customMessageBg", filled);

	const backgroundStart = sample.slice(0, spaceIndex);
	const backgroundEnd = sample.slice(spaceIndex + 1);
	return `${backgroundStart}${filled.replace(RESET_ANSI, `${RESET}${backgroundStart}`)}${backgroundEnd}`;
}

export const ANSI_RESET = RESET;
