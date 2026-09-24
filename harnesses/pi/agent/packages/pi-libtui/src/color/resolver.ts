import { type Color256Index, color256Index, type RgbColor, rgb as rgbColor, xtermColor } from "./palette.ts";

/** A resolved palette entry or an exact color measured at a terminal boundary. */
export type ColorValue = Color256Index | RgbColor;

const closestXtermCache = new Map<string, number>();

/** Render and measure one direct value through the active terminal policy. */
export function createColorResolver(context: {
	readonly resolvedPalette?: readonly RgbColor[];
	readonly output: "direct-indexed" | "quantized-indexed" | "truecolor";
}) {
	const dark = color256Index(0, 0, 0);
	const light = color256Index(5, 5, 5);
	const rgb = (value: ColorValue): RgbColor => {
		return typeof value === "number" ? (context.resolvedPalette?.[value] ?? xtermColor(value)) : value;
	};
	const ansi = (value: ColorValue, background: boolean): string => {
		const prefix = background ? 48 : 38;
		if (context.output !== "truecolor") {
			const index =
				typeof value === "number" && context.output === "direct-indexed" ? value : closestXtermIndex(rgb(value));
			return `\x1b[${prefix};5;${index}m`;
		}
		const color = rgb(value);
		return `\x1b[${prefix};2;${color.r};${color.g};${color.b}m`;
	};
	return {
		rgb,
		ansi,
		contrast(value: ColorValue) {
			const background = rgb(value);
			const preferred = contrastRatio(background, rgb(dark)) >= contrastRatio(background, rgb(light)) ? dark : light;
			if (contrastRatio(background, rgb(preferred)) >= 4.5) return preferred;
			// A dark theme on a light terminal can give the generated palette two dark endpoints.
			const black = rgbColor(0, 0, 0);
			const white = rgbColor(255, 255, 255);
			return contrastRatio(background, black) >= contrastRatio(background, white) ? black : white;
		},
		contrastRatio(left: ColorValue, right: ColorValue) {
			return contrastRatio(rgb(left), rgb(right));
		},
	};
}

function contrastRatio(left: RgbColor, right: RgbColor): number {
	const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
	const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: RgbColor): number {
	const channel = (value: number): number => {
		const normalized = value / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	};
	return channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
}

function closestXtermIndex(color: RgbColor): number {
	const key = `${color.r},${color.g},${color.b}`;
	const cached = closestXtermCache.get(key);
	if (cached !== undefined) return cached;
	let best = 0;
	let distance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < 256; index += 1) {
		const candidate = xtermColor(index);
		const next =
			(color.r - candidate.r) ** 2 * 0.299 +
			(color.g - candidate.g) ** 2 * 0.587 +
			(color.b - candidate.b) ** 2 * 0.114;
		if (next < distance) {
			best = index;
			distance = next;
		}
	}
	if (closestXtermCache.size >= 4096) closestXtermCache.clear();
	closestXtermCache.set(key, best);
	return best;
}
