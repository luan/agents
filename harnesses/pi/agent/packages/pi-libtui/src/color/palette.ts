export interface RgbColor {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export type TuiHue = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "gray";
export type TuiShade = 0 | 1 | 2 | 3 | 4 | 5;

export interface TuiSwatch {
	readonly hue: TuiHue;
	readonly shade: TuiShade;
}

declare const COLOR256_INDEX: unique symbol;

/** An ANSI 0..255 index produced by one of the validated palette constructors. */
export type Color256Index = number & { readonly [COLOR256_INDEX]: true };

// CIELAB conversion and interpolation are a TypeScript port of the public-domain
// color256 implementation: https://github.com/jake-stewart/color256

type LabColor = readonly [number, number, number];

const XTERM_BASE_16 = [
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
] as const;

export function rgb(r: number, g: number, b: number): RgbColor {
	return Object.freeze({ r: channel(r), g: channel(g), b: channel(b) });
}

/** Simple YIQ luminance for choosing between light and dark text. */
export function yiqLuminance(color: RgbColor): number {
	return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}

export function xtermColor(index: number): RgbColor {
	const bounded = Math.max(0, Math.min(255, Math.floor(index)));
	if (bounded < 16) {
		const [red, green, blue] = XTERM_BASE_16[bounded]!;
		return rgb(red, green, blue);
	}
	if (bounded >= 232) {
		const value = 8 + (bounded - 232) * 10;
		return rgb(value, value, value);
	}
	const cubeOffset = bounded - 16;
	return rgb(
		xtermChannel(Math.floor(cubeOffset / 36) % 6),
		xtermChannel(Math.floor(cubeOffset / 6) % 6),
		xtermChannel(cubeOffset % 6),
	);
}

/** Select a color256 entry using logical red, green, and blue channels from 0 through 5. */
export function color256Index(red: number, green: number, blue: number): Color256Index {
	validateColor256Level(red);
	validateColor256Level(green);
	validateColor256Level(blue);
	return (16 + red * 36 + green * 6 + blue) as Color256Index;
}

/** Select a grayscale entry while preserving logical dark/light ordering. */
export function gray256Index(value: number): Color256Index {
	if (!Number.isInteger(value) || value < 0 || value > 23) {
		throw new RangeError(`Gray palette channel must be an integer from 0 through 23; received ${value}`);
	}
	return (232 + value) as Color256Index;
}

/** Resolve a six-level hue and shade to its corresponding color256 index. */
export function swatch(hue: TuiHue, shade: TuiShade): Color256Index {
	if (hue === "gray") return gray256Index(Math.round((shade * 23) / 5));
	const channels: Record<Exclude<TuiHue, "gray">, readonly [number, number, number]> = {
		red: [shade, 0, 0],
		green: [0, shade, 0],
		yellow: [shade, shade, 0],
		blue: [0, 0, shade],
		magenta: [shade, 0, shade],
		cyan: [0, shade, shade],
	};
	return color256Index(...channels[hue]);
}

function validateColor256Level(value: number): void {
	if (!Number.isInteger(value) || value < 0 || value > 5) {
		throw new RangeError(`Color cube channel must be an integer from 0 through 5; received ${value}`);
	}
}

/** Generate the extended palette described by jake-stewart/color256. */
export function generateColor256(
	base16: readonly RgbColor[],
	background: RgbColor,
	foreground: RgbColor,
): readonly RgbColor[] {
	if (base16.length < 16) throw new RangeError("A base16 palette needs 16 colors");
	const backgroundLab = rgbToLab(background);
	const foregroundLab = rgbToLab(foreground);
	const corners = [
		backgroundLab,
		rgbToLab(base16[1]!),
		rgbToLab(base16[2]!),
		rgbToLab(base16[3]!),
		rgbToLab(base16[4]!),
		rgbToLab(base16[5]!),
		rgbToLab(base16[6]!),
		foregroundLab,
	] as const;
	const palette: RgbColor[] = base16.slice(0, 16).map((color) => rgb(color.r, color.g, color.b));

	for (let red = 0; red < 6; red += 1) {
		const c0 = lerpLab(red / 5, corners[0], corners[1]);
		const c1 = lerpLab(red / 5, corners[2], corners[3]);
		const c2 = lerpLab(red / 5, corners[4], corners[5]);
		const c3 = lerpLab(red / 5, corners[6], corners[7]);
		for (let green = 0; green < 6; green += 1) {
			const c4 = lerpLab(green / 5, c0, c1);
			const c5 = lerpLab(green / 5, c2, c3);
			for (let blue = 0; blue < 6; blue += 1) {
				palette.push(labToRgb(lerpLab(blue / 5, c4, c5)));
			}
		}
	}

	for (let shade = 0; shade < 24; shade += 1) {
		palette.push(labToRgb(lerpLab((shade + 1) / 25, corners[0], corners[7])));
	}
	return Object.freeze(palette);
}

function rgbToLab(color: RgbColor): LabColor {
	const [red, green, blue] = [color.r, color.g, color.b].map((value) => {
		const normalized = value / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	const x = (red! * 0.4124 + green! * 0.3576 + blue! * 0.1805) / 0.95047;
	const y = red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
	const z = (red! * 0.0193 + green! * 0.1192 + blue! * 0.9505) / 1.08883;
	const [fx, fy, fz] = [x, y, z].map((value) => (value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116));
	return [116 * fy! - 16, 500 * (fx! - fy!), 200 * (fy! - fz!)];
}

function labToRgb([lightness, a, b]: LabColor): RgbColor {
	const fy = (lightness + 16) / 116;
	const fx = a / 500 + fy;
	const fz = fy - b / 200;
	const [x0, y0, z0] = [fx, fy, fz].map((value) => (value ** 3 > 0.008856 ? value ** 3 : (value - 16 / 116) / 7.787));
	const x = x0! * 0.95047;
	const y = y0!;
	const z = z0! * 1.08883;
	const values = [
		x * 3.2406 + y * -1.5372 + z * -0.4986,
		x * -0.9689 + y * 1.8758 + z * 0.0415,
		x * 0.0557 + y * -0.204 + z * 1.057,
	].map((value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
	return rgb(values[0]! * 255, values[1]! * 255, values[2]! * 255);
}

function lerpLab(t: number, left: LabColor, right: LabColor): LabColor {
	return [left[0] + t * (right[0] - left[0]), left[1] + t * (right[1] - left[1]), left[2] + t * (right[2] - left[2])];
}

function channel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function xtermChannel(value: number): number {
	return value === 0 ? 0 : 55 + value * 40;
}
