import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Compact, deterministic burden meter used in rows and summaries. */
export function burdenBar(value: number, total: number, width = 12, fill = "█", empty = "·"): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
	return `${fill.repeat(Math.round(ratio * safeWidth))}${empty.repeat(safeWidth - Math.round(ratio * safeWidth))}`;
}

export function fitBurdenBar(value: number, total: number, width: number): string {
	return truncateToWidth(burdenBar(value, total, Math.max(1, width)), width, "");
}

export function percent(value: number, total: number): string {
	return total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
}

export function burdenWidth(label: string, width: number): number {
	return Math.max(1, width - visibleWidth(label) - 10);
}
