export function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return Math.round(tokens).toLocaleString();
	const thousands = tokens / 1_000;
	return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

const horizontalRule = "─";

// Split width around contentWidth into left/right rule strings, or undefined if too narrow (< 4 cols spare).
export function splitRule(width: number, contentWidth: number): { left: string; right: string } | undefined {
	const remaining = width - contentWidth - 2;
	if (remaining < 4) return undefined;
	const left = Math.floor(remaining / 2);
	return { left: horizontalRule.repeat(left), right: horizontalRule.repeat(remaining - left) };
}
