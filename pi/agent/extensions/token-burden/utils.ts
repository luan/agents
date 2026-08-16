import type { BarSegment } from "./types.js";

/**
 * Compute bar segment widths proportional to token counts.
 * Each segment gets at least 1 character. Excess is stolen from the largest.
 */
export function buildBarSegments(sections: { label: string; tokens: number }[], barWidth: number): BarSegment[] {
	if (sections.length === 0) {
		return [];
	}

	const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

	// If all tokens are zero, distribute evenly
	if (totalTokens === 0) {
		const baseWidth = Math.floor(barWidth / sections.length);
		let remainder = barWidth - baseWidth * sections.length;
		return sections.map((s) => {
			const extra = remainder > 0 ? 1 : 0;
			remainder--;
			return { label: s.label, width: baseWidth + extra };
		});
	}

	// Compute proportional widths
	const raw = sections.map((s) => (s.tokens / totalTokens) * barWidth);

	// Floor each, enforce minimum 1
	const widths = raw.map((w) => Math.max(1, Math.floor(w)));

	// Adjust total to match barWidth
	const currentTotal = widths.reduce((sum, w) => sum + w, 0);
	const diff = barWidth - currentTotal;

	if (diff > 0) {
		// Distribute extra to segments with largest fractional parts
		const fractionals = raw.map((w, i) => ({ index: i, frac: w - widths[i] }));
		fractionals.sort((a, b) => b.frac - a.frac);
		for (let i = 0; i < diff; i++) {
			widths[fractionals[i % fractionals.length].index]++;
		}
	} else if (diff < 0) {
		// Steal from largest segments
		for (let i = 0; i < -diff; i++) {
			let maxIdx = 0;
			for (let j = 1; j < widths.length; j++) {
				if (widths[j] > widths[maxIdx]) {
					maxIdx = j;
				}
			}
			if (widths[maxIdx] > 1) {
				widths[maxIdx]--;
			}
		}
	}

	return sections.map((s, i) => ({ label: s.label, width: widths[i] }));
}
