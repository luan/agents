import { italic } from "./tui/text";

type CompactSummaryTheme = {
	fg(role: string, text: string): string;
	bold(text: string): string;
};

function osc8Link(text: string, url: string | undefined): string {
	return url && !/[\u0000-\u001f\u007f]/.test(url) ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

export function renderCompactSummaryLine(
	theme: CompactSummaryTheme,
	summary: {
		icon: string;
		label: string;
		name: string;
		path?: string;
		meta?: string;
		pathUrl?: string;
	},
): string {
	const meta = summary.meta ? ` ${theme.fg("muted", summary.meta)}` : "";
	const path = summary.path ? ` ${osc8Link(theme.fg("mdLink", summary.path), summary.pathUrl)}` : "";
	return `${theme.fg("accent", summary.icon)} ${theme.fg("toolTitle", theme.bold(summary.label))} ${theme.fg("success", italic(summary.name))}${path}${meta}`;
}
