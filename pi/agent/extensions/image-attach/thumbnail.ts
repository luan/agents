import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { transmitKittyInlineImageRow } from "../shared/kitty-virtual-image";
import { magickBuffer } from "./magick";

/** Cells the thumbnail may use: exactly the width of `image ` inside a handle. */
export const THUMBNAIL_CELLS = 6;

/** Half blocks give two pixel rows per cell, and one row is all a handle has. */
const THUMBNAIL_ROWS = 2;

/** Source pixels sampled per cell edge. Enough to find the ink, small enough to stay cheap. */
const CELL_SAMPLES = 8;

/** Upper half block — foreground paints the top pixel row, background the bottom one. */
const HALF_BLOCK = "▀";

/** Below this luminance range the image really is flat, so stretching would invent contrast. */
const MIN_STRETCH_RANGE = 8;

/** Keep stretched cells inside this luminance band so nothing turns to mud or blows out. */
const STRETCH_FLOOR = 0.22;
const STRETCH_CEILING = 0.97;

export type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * One colour per cell, taken from a `cells*CELL_SAMPLES` × `rows*CELL_SAMPLES` raster.
 *
 * Averaging is what made screenshots useless here: a page of dark text on white averages to
 * white, so every UI capture came out the same pale square. Each cell instead keeps the pixel
 * furthest from its own block's mean — the ink rather than the paper — which is what carries the
 * layout, and works the same for dark screenshots where the outlier is the bright text.
 */
export function pickCellColors(bytes: Buffer, cells = THUMBNAIL_CELLS, samples = CELL_SAMPLES): Rgb[] | undefined {
	const width = cells * samples;
	if (bytes.length < width * THUMBNAIL_ROWS * samples * 3) return undefined;

	const picked: Rgb[] = [];
	for (let row = 0; row < THUMBNAIL_ROWS; row++) {
		for (let cell = 0; cell < cells; cell++) {
			const block: Rgb[] = [];
			for (let y = 0; y < samples; y++) {
				for (let x = 0; x < samples; x++) {
					const at = ((row * samples + y) * width + cell * samples + x) * 3;
					block.push([bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0]);
				}
			}
			const mean = block.reduce((total, pixel) => total + luminance(pixel), 0) / block.length;
			picked.push(
				block.reduce((best, pixel) =>
					Math.abs(luminance(pixel) - mean) > Math.abs(luminance(best) - mean) ? pixel : best,
				),
			);
		}
	}
	return picked;
}

/**
 * Spread the picked colours across the visible range by luminance rank, scaling each cell's
 * value channel so hue and saturation survive. Six cells of near-white differ by a few points
 * that no one can see; after this they differ by something a glance can catch.
 */
export function stretchCellColors(colors: readonly Rgb[]): Rgb[] {
	const luminances = colors.map(luminance);
	const low = Math.min(...luminances);
	const range = Math.max(...luminances) - low;
	if (range < MIN_STRETCH_RANGE) return [...colors];

	return colors.map((color) => {
		const position = (luminance(color) - low) / range;
		const target = (STRETCH_FLOOR + position * (STRETCH_CEILING - STRETCH_FLOOR)) * 255;
		const value = Math.max(...color) || 1;
		const scale = Math.min(255 / value, target / value);
		return color.map((channel) => Math.min(255, Math.round(channel * scale))) as Rgb;
	});
}

/** Render the top row of colours as foregrounds over the bottom row as backgrounds. */
export function cellsToHalfBlocks(colors: readonly Rgb[], cells = THUMBNAIL_CELLS): string | undefined {
	if (colors.length < cells * THUMBNAIL_ROWS) return undefined;
	let row = "";
	for (let cell = 0; cell < cells; cell++) {
		const [tr, tg, tb] = colors[cell] as Rgb;
		const [br, bg, bb] = colors[cells + cell] as Rgb;
		row += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m${HALF_BLOCK}`;
	}
	// A full reset rather than `\x1b[49m`: the polished editor re-applies its own background after
	// every reset it finds in a line, which is what keeps the rest of the row seam-free.
	return `${row}\x1b[0m`;
}

/**
 * A real image in the handle, for terminals speaking the kitty graphics protocol. The whole
 * picture is squashed into the slot rather than centre-cropped: at six cells the point is
 * recognising *which* screenshot this is, and a cropped middle band of a page of text tells you
 * far less than the squashed layout does.
 */
export async function renderGraphicsThumbnail(
	path: string,
	cells: number,
	write?: (sequence: string) => void,
): Promise<string | undefined> {
	if (getCapabilities().images !== "kitty") return undefined;
	const cell = getCellDimensions();
	const width = Math.max(1, cells * Math.max(1, cell.widthPx));
	const height = Math.max(1, cell.heightPx);
	const png = await magickBuffer(path, ["-resize", `${width}x${height}!`, "-strip", "png:-"]);
	if (!png?.length) return undefined;
	return transmitKittyInlineImageRow(png.toString("base64"), cells, undefined, write);
}

/** The colour-signature fallback for terminals without kitty graphics. */
async function renderSignatureThumbnail(path: string, cells: number): Promise<string | undefined> {
	if (!getCapabilities().trueColor) return undefined;
	const raster = await magickBuffer(path, [
		"-colorspace",
		"sRGB",
		"-resize",
		`${cells * CELL_SAMPLES}x${THUMBNAIL_ROWS * CELL_SAMPLES}!`,
		"-depth",
		"8",
		"rgb:-",
	]);
	if (!raster) return undefined;
	const picked = pickCellColors(raster, cells);
	return picked && cellsToHalfBlocks(stretchCellColors(picked), cells);
}

/**
 * The thumbnail for `path`: a real image where the terminal can draw one, a colour signature
 * where it can only do truecolour, and undefined when it can do neither or `magick` is missing —
 * the handle then keeps its plain `[image #N]` text.
 */
export async function renderThumbnailCells(path: string, cells = THUMBNAIL_CELLS): Promise<string | undefined> {
	return (await renderGraphicsThumbnail(path, cells)) ?? (await renderSignatureThumbnail(path, cells));
}
