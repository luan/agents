import { execFileSync } from "node:child_process";
import {
	type Component,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	Image,
	setCapabilities,
} from "@earendil-works/pi-tui";

type ImageDimensions = { widthPx: number; heightPx: number };

type KittyVirtualImageTheme = {
	fallbackColor: (text: string) => string;
};

type KittyVirtualImageOptions = {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	imageId?: number;
	sourcePath?: string;
};

function isTmuxSession(): boolean {
	return Boolean(process.env.TMUX) || (process.env.TERM ?? "").toLowerCase().startsWith("tmux");
}

function tmux(args: string[]): string | undefined {
	try {
		return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 250 }).trim();
	} catch {
		return undefined;
	}
}

function tmuxPassthroughEnabled(): boolean {
	const value = tmux(["show-options", "-qv", "-p", "allow-passthrough"])?.toLowerCase();
	return value === "on" || value === "all";
}

function tmuxClientSupportsKitty(): boolean {
	const term = tmux(["display-message", "-p", "#{client_termname}"])?.toLowerCase() ?? "";
	return /bootty|ghostty|kitty|wezterm/.test(term);
}

export function configureTmuxKittyImageCapability(): void {
	const caps = getCapabilities();
	if (caps.images) return;
	if (!isTmuxSession()) return;
	if (!tmuxPassthroughEnabled() || !tmuxClientSupportsKitty()) return;
	setCapabilities({
		...caps,
		images: "kitty",
		trueColor: caps.trueColor || process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit",
	});
}

function tmuxWrap(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function forTerminal(sequence: string): string {
	return isTmuxSession() ? tmuxWrap(sequence) : sequence;
}

const PLACEHOLDER = "\u{10EEEE}";
const DIACRITICS = [
	"\u{0305}",
	"\u{030D}",
	"\u{030E}",
	"\u{0310}",
	"\u{0312}",
	"\u{033D}",
	"\u{033E}",
	"\u{033F}",
	"\u{0346}",
	"\u{034A}",
	"\u{034B}",
	"\u{034C}",
	"\u{0350}",
	"\u{0351}",
	"\u{0352}",
	"\u{0357}",
	"\u{035B}",
	"\u{0363}",
	"\u{0364}",
	"\u{0365}",
	"\u{0366}",
	"\u{0367}",
	"\u{0368}",
	"\u{0369}",
	"\u{036A}",
	"\u{036B}",
	"\u{036C}",
	"\u{036D}",
	"\u{036E}",
	"\u{036F}",
	"\u{0483}",
	"\u{0484}",
	"\u{0485}",
	"\u{0486}",
	"\u{0487}",
	"\u{0592}",
	"\u{0593}",
	"\u{0594}",
	"\u{0595}",
	"\u{0597}",
	"\u{0598}",
	"\u{0599}",
	"\u{059C}",
	"\u{059D}",
	"\u{059E}",
	"\u{059F}",
	"\u{05A0}",
	"\u{05A1}",
	"\u{05A8}",
	"\u{05A9}",
	"\u{05AB}",
	"\u{05AC}",
	"\u{05AF}",
	"\u{05C4}",
	"\u{0610}",
	"\u{0611}",
	"\u{0612}",
	"\u{0613}",
	"\u{0614}",
	"\u{0615}",
	"\u{0616}",
	"\u{0617}",
	"\u{0657}",
	"\u{0658}",
	"\u{0659}",
	"\u{065A}",
	"\u{065B}",
	"\u{065D}",
	"\u{065E}",
	"\u{06D6}",
	"\u{06D7}",
	"\u{06D8}",
	"\u{06D9}",
	"\u{06DA}",
	"\u{06DB}",
	"\u{06DC}",
	"\u{06DF}",
	"\u{06E0}",
	"\u{06E1}",
	"\u{06E2}",
] as const;

function sgrForegroundForId(imageId: number): string {
	const red = (imageId >> 16) & 0xff;
	const green = (imageId >> 8) & 0xff;
	const blue = imageId & 0xff;
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function placeholderCell(row: number, col: number): string {
	return `${PLACEHOLDER}${DIACRITICS[row] ?? ""}${DIACRITICS[col] ?? ""}`;
}

function placeholderRow(row: number, columns: number, imageId: number): string {
	let cells = "";
	for (let col = 0; col < columns; col++) cells += placeholderCell(row, col);
	return `${sgrForegroundForId(imageId)}${cells}\x1b[39m`;
}

function stableVirtualImageId(data: string, mimeType: string, columns: number, rows: number): number {
	return stableImageId(`${data}\0${columns}\0${rows}`, mimeType);
}
function clampPositiveInteger(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function calculateCellSize(
	dimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells: number | undefined,
): { columns: number; rows: number } {
	const cell = getCellDimensions();
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const widthScale = (maxWidth * cell.widthPx) / Math.max(1, dimensions.widthPx);
	const heightScale =
		maxHeight === undefined ? widthScale : (maxHeight * cell.heightPx) / Math.max(1, dimensions.heightPx);
	const scale = Math.min(widthScale, heightScale);
	const columns = Math.round((dimensions.widthPx * scale) / cell.widthPx);
	const rows = Math.round((dimensions.heightPx * scale) / cell.heightPx);
	return {
		columns: Math.max(1, Math.min(maxWidth, columns)),
		rows: Math.max(1, maxHeight === undefined ? rows : Math.min(maxHeight, rows)),
	};
}

function stableImageId(data: string, mimeType: string): number {
	let hash = 0x811c9dc5;
	const input = `${mimeType}\0${data}`;
	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const id = hash & 0x00ffffff;
	return id === 0 ? 1 : id;
}

function kittySequence(params: string, payload = ""): string {
	return `\x1b_G${params};${payload}\x1b\\`;
}

function base64EncodeUtf8(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function uploadSequence(
	base64Data: string,
	imageId: number,
	columns: number,
	rows: number,
	sourcePath?: string,
): string {
	const chunkSize = 4096;
	const params = sourcePath
		? `a=T,t=f,f=100,U=1,c=${columns},r=${rows},q=2,i=${imageId}`
		: `a=T,f=100,U=1,c=${columns},r=${rows},q=2,i=${imageId}`;
	const payload = sourcePath ? base64EncodeUtf8(sourcePath) : base64Data;
	if (payload.length <= chunkSize) return forTerminal(kittySequence(params, payload));

	const chunks: string[] = [];
	for (let offset = 0; offset < payload.length; offset += chunkSize) {
		const chunk = payload.slice(offset, offset + chunkSize);
		const isFirst = offset === 0;
		const isLast = offset + chunkSize >= payload.length;
		if (isFirst) chunks.push(kittySequence(`${params},m=1`, chunk));
		else if (isLast) chunks.push(kittySequence("m=0", chunk));
		else chunks.push(kittySequence("m=1", chunk));
	}
	return forTerminal(chunks.join(""));
}

export function resetKittyVirtualImageUploadCache(): void {}

function imageFallback(mimeType: string, dimensions: ImageDimensions, filename?: string): string {
	const name = filename ? `${filename} ` : "";
	return `[Image: ${name}[${mimeType}] ${dimensions.widthPx}x${dimensions.heightPx}]`;
}

export class KittyVirtualImage implements Component {
	private readonly dimensions: ImageDimensions;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private nativeImage?: Image;

	constructor(
		private readonly base64Data: string,
		private readonly mimeType: string,
		private readonly theme: KittyVirtualImageTheme,
		private readonly options: KittyVirtualImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.dimensions = dimensions ?? getImageDimensions(base64Data, mimeType) ?? { widthPx: 800, heightPx: 600 };
		if (options.imageId !== undefined && (options.imageId < 1 || options.imageId > 0x00ffffff)) {
			throw new Error("Kitty virtual image ids must be in the 24-bit RGB range.");
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.nativeImage?.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const caps = getCapabilities();
		if (caps.images !== "kitty") {
			if (caps.images) {
				this.nativeImage ??= new Image(this.base64Data, this.mimeType, this.theme, this.options, this.dimensions);
				this.cachedLines = this.nativeImage.render(width);
			} else {
				this.cachedLines = [
					this.theme.fallbackColor(imageFallback(this.mimeType, this.dimensions, this.options.filename)),
				];
			}
			this.cachedWidth = width;
			return this.cachedLines;
		}

		if (this.mimeType !== "image/png") {
			this.cachedLines = [
				this.theme.fallbackColor(imageFallback(this.mimeType, this.dimensions, this.options.filename)),
			];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, clampPositiveInteger(this.options.maxWidthCells, 60)));
		const cell = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cell.widthPx) / cell.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;
		const { columns, rows } = calculateCellSize(this.dimensions, maxWidth, maxHeight);

		const imageId =
			this.options.imageId ??
			stableVirtualImageId(this.options.sourcePath ?? this.base64Data, this.mimeType, columns, rows);
		const lines = [
			`${uploadSequence(this.base64Data, imageId, columns, rows, this.options.sourcePath)}${placeholderRow(0, columns, imageId)}`,
		];
		for (let row = 1; row < rows; row++) lines.push(placeholderRow(row, columns, imageId));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}
