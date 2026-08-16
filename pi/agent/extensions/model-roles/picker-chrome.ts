import { decodeKittyPrintable, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PickerTheme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

export type PickerTui = Pick<TUI, "requestRender" | "terminal">;

export const BORDER = "accent";

export function frame(theme: PickerTheme, content: string, width: number): string {
	const clipped = truncateToWidth(content, width);
	return `${theme.fg(BORDER, "│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${theme.fg(BORDER, "│")}`;
}

export function bottom(theme: PickerTheme, width: number): string {
	return theme.fg(BORDER, `└${"─".repeat(Math.max(0, width))}┘`);
}

export function printableText(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable !== undefined) return kittyPrintable;
	if (
		!data ||
		[...data].some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		})
	)
		return undefined;
	return data;
}

export function selectedIndex(options: string[], selected: string | undefined): number {
	const index = selected ? options.indexOf(selected) : -1;
	return index >= 0 ? index : 0;
}
