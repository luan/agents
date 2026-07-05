import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

export function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, width, "");
	const spaces = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${spaces}`;
}

export const ANSI_RESET = RESET;
