import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
