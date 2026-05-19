export type AnimationTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

type Rgb = [number, number, number];

const RGB_FALLBACK: Rgb = [0xff, 0xff, 0xff];
const TRICKLE_SHINE_WIDTH = 3;
const TRICKLE_STEP_MS = 80;

export function highlightTrickle(
	text: string,
	theme: AnimationTheme,
	elapsedMs: number | undefined,
	color = "accent",
): string {
	const baseAnsi = colorAnsi(theme, color);
	if (!baseAnsi) return theme.fg(color, text);
	const base = scaleRgb(colorRgb(theme, color), 0.55);
	const shine = scaleRgb(colorRgb(theme, color), 1.55);
	const chars = [...text];
	const step = Math.floor((elapsedMs ?? 0) / TRICKLE_STEP_MS);
	const cycle = chars.length + TRICKLE_SHINE_WIDTH;
	const pos = step % cycle;
	return `${chars
		.map((ch, index) => {
			const inShine = index >= pos - TRICKLE_SHINE_WIDTH && index < pos;
			return `${rgbFg(inShine ? shine : base)}${ch}`;
		})
		.join("")}\x1b[39m`;
}

export function colorAnsi(theme: Pick<AnimationTheme, "fg">, color: string): string | undefined {
	const withGetter = theme as Pick<AnimationTheme, "fg"> & { getFgAnsi?: (color: string) => string };
	if (withGetter.getFgAnsi) return withGetter.getFgAnsi(color);
	const sample = theme.fg(color, "x");
	const marker = sample.indexOf("x");
	const ansi = marker >= 0 ? sample.slice(0, marker) : undefined;
	return ansi?.includes("\x1b[38;") ? ansi : undefined;
}

export function colorRgb(theme: Pick<AnimationTheme, "fg">, color: string): Rgb {
	const ansi = colorAnsi(theme, color);
	const truecolor = ansi?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];

	const color256 = ansi?.match(/\x1b\[38;5;(\d+)m/);
	if (color256) return ansi256ToRgb(Number(color256[1]));

	return RGB_FALLBACK;
}

export function scaleRgb([r, g, b]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(r), scale(g), scale(b)];
}

export function rgbFg([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function ansi256ToRgb(code: number): Rgb {
	if (code < 16) {
		const base: Rgb[] = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		return base[code] ?? RGB_FALLBACK;
	}
	if (code >= 16 && code <= 231) {
		const n = code - 16;
		const r = Math.floor(n / 36);
		const g = Math.floor((n % 36) / 6);
		const b = n % 6;
		const scale = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [scale(r), scale(g), scale(b)];
	}
	const gray = 8 + (code - 232) * 10;
	return [gray, gray, gray];
}
