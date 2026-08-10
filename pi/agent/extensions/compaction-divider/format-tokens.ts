export function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return Math.round(tokens).toLocaleString();
	const thousands = tokens / 1_000;
	return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}
