import { describe, expect, it } from "bun:test";
import {
	approxTokenCount,
	estimateImageTokens,
	imageTokensForDimensions,
	readImageDimensions,
} from "./output-budget.ts";

// Prompt-token cost of one image block on gpt-5.6-luna via openai-codex-responses, against an 8x8 control.
const MEASURED_IMAGE_BLOCK_TOKENS = [
	{ width: 100, height: 100, measured: 19 },
	{ width: 320, height: 240, measured: 96 },
	{ width: 720, height: 540, measured: 464 },
	{ width: 1024, height: 1024, measured: 1228 },
	{ width: 1152, height: 1152, measured: 1555 },
	{ width: 1216, height: 1216, measured: 1732 },
	{ width: 1408, height: 1408, measured: 2323 },
	{ width: 2000, height: 1500, measured: 3548 },
	{ width: 2000, height: 2000, measured: 4779 },
];

function pngHeader(width: number, height: number): Buffer {
	const head = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(head, 0);
	Buffer.from("IHDR", "ascii").copy(head, 12);
	head.writeUInt32BE(width, 16);
	head.writeUInt32BE(height, 20);
	return head;
}

// An APP1 segment ahead of SOF0, so the scan has to walk a segment rather than read a fixed offset.
function jpegHeader(width: number, height: number): Buffer {
	const app1 = Buffer.alloc(18);
	app1.writeUInt16BE(0xffe1, 0);
	app1.writeUInt16BE(16, 2);
	const sof0 = Buffer.alloc(11);
	sof0.writeUInt16BE(0xffc0, 0);
	sof0.writeUInt16BE(17, 2);
	sof0.writeUInt8(8, 4);
	sof0.writeUInt16BE(height, 5);
	sof0.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0]);
}

describe("imageTokensForDimensions", () => {
	// The flat 1,200 this replaced under-counted 2000x1500 by 3x and over-counted 320x240 by 12x.
	it.each(MEASURED_IMAGE_BLOCK_TOKENS)("lands within 1.5% at $width x $height", ({ width, height, measured }) => {
		const estimate = imageTokensForDimensions(width, height);
		expect(Math.abs(estimate - measured) / measured).toBeLessThan(0.015);
	});

	it("takes the fallback for a zero dimension", () => {
		expect(imageTokensForDimensions(0, 540)).toBe(469);
	});
});

describe("readImageDimensions", () => {
	it.each(MEASURED_IMAGE_BLOCK_TOKENS)("reads $width x $height from a PNG and a JPEG", ({ width, height }) => {
		expect(readImageDimensions(pngHeader(width, height))).toEqual({ width, height });
		expect(readImageDimensions(jpegHeader(width, height))).toEqual({ width, height });
	});

	it("reads nothing from a GIF, which takes the fallback", () => {
		expect(readImageDimensions(Buffer.from("GIF89a placeholder", "ascii"))).toBeUndefined();
	});
});

describe("estimateImageTokens", () => {
	// A 720x540 PNG carries 535,708 base64 chars against the JPEG's 241,272, and both occupy 469 tokens.
	it("charges one image the same through either encoding", () => {
		const fromPng = estimateImageTokens(pngHeader(720, 540).toString("base64"));
		expect(estimateImageTokens(jpegHeader(720, 540).toString("base64"))).toBe(fromPng);
		expect(fromPng).toBe(469);
	});

	it("takes the fallback for a non-string payload", () => {
		expect(estimateImageTokens(undefined)).toBe(469);
	});
});

// `realTokens` are recorded o200k_base (gpt-4o) counts, held as literals rather than recomputed, so these stay a fixed
// target if the tokenizer is swapped. True bytes-per-token across 35 tool outputs ran 2.17 to 5.49.
const TOKENIZER_FIXTURES: Array<{ label: string; realTokens: number; text: string }> = [
	{
		label: "searchOutput",
		realTokens: 161,
		text: '[crates/vlt/src/graph.rs#8A3F]\n 12:pub fn resolve_path(stem_or_path: &str, kind: ArtifactKind) -> Result<PathBuf, VaultError> {\n 13:    let source_path = resolve_path(stem_or_path, kind)?;\n 14:    let source = read_indexed(&source_path)?;\n 15:}\n[crates/ct/src/apply_patch/parser.rs#5C21]\n 88:#[derive(Debug, thiserror::Error)]\n 89:pub enum ApplyPatchError {\n 90:    #[error("parse error: {0}")]\n 91:    Parse(String),\n\nShowing files 1-2 of 27. Use skip=2 for the next page, or narrow paths/pattern.',
	},
	{
		label: "lsLongListing",
		realTokens: 213,
		text: "total 328\ndrwxr-xr-x  12 luan  staff    384 Aug 13 10:06 .\ndrwxr-xr-x   8 luan  staff    256 Aug 13 10:05 ..\n-rw-r--r--   1 luan  staff  18232 Aug 13 10:06 apply.rs\n-rw-r--r--   1 luan  staff   4821 Aug 13 10:06 diff.rs\n-rw-r--r--   1 luan  staff   1204 Aug 13 10:06 mod.rs\n-rw-r--r--   1 luan  staff  48922 Aug 13 10:06 parser.rs\n-rw-r--r--   1 luan  staff   9310 Aug 13 10:06 repair.rs\n-rw-r--r--   1 luan  staff   2118 Aug 13 10:06 scope.rs",
	},
	{
		label: "compactJson",
		realTokens: 554,
		text: '[{"id":0,"name":"item-0","path":"crates/x/y0.rs","ok":true},{"id":1,"name":"item-1","path":"crates/x/y1.rs","ok":false},{"id":2,"name":"item-2","path":"crates/x/y2.rs","ok":true},{"id":3,"name":"item-3","path":"crates/x/y3.rs","ok":false},{"id":4,"name":"item-4","path":"crates/x/y4.rs","ok":true},{"id":5,"name":"item-5","path":"crates/x/y5.rs","ok":false},{"id":6,"name":"item-6","path":"crates/x/y6.rs","ok":true},{"id":7,"name":"item-7","path":"crates/x/y7.rs","ok":false},{"id":8,"name":"item-8","path":"crates/x/y8.rs","ok":true},{"id":9,"name":"item-9","path":"crates/x/y9.rs","ok":false},{"id":10,"name":"item-10","path":"crates/x/y10.rs","ok":true},{"id":11,"name":"item-11","path":"crates/x/y11.rs","ok":false},{"id":12,"name":"item-12","path":"crates/x/y12.rs","ok":true},{"id":13,"name":"item-13","path":"crates/x/y13.rs","ok":false},{"id":14,"name":"item-14","path":"crates/x/y14.rs","ok":true},{"id":15,"name":"item-15","path":"crates/x/y15.rs","ok":false},{"id":16,"name":"item-16","path":"crates/x/y16.rs","ok":true},{"id":17,"name":"item-17","path":"crates/x/y17.rs","ok":false},{"id":18,"name":"item-18","path":"crates/x/y18.rs","ok":true},{"id":19,"name":"item-19","path":"crates/x/y19.rs","ok":false},{"id":20,"name":"item-20","path":"crates/x/y20.rs","ok":true},{"id":21,"name":"item-21","path":"crates/x/y21.rs","ok":false},{"id":22,"name":"item-22","path":"crates/x/y22.rs","ok":true},{"id":23,"name":"item-23","path":"crates/x/y23.rs","ok":false}]',
	},
	{
		label: "rawTypeScript",
		realTokens: 144,
		text: 'export function truncateMiddleByTokens(text: string, maxTokens: number, options: TruncateOptions = {}): BoundedText {\n\tconst totalBytes = Buffer.byteLength(text, "utf8");\n\tconst originalTokens = Math.ceil(totalBytes / BYTES_PER_TOKEN);\n\tconst budget = contentBudget(maxTokens);\n\tif (originalTokens <= budget) {\n\t\treturn { text, truncated: false, originalTokens, originalLines: countLines(text) };\n\t}\n\tconst originalLines = countLines(text);\n\tconst headBudgetBytes = Math.max(1, Math.floor(budget * HEAD_SHARE)) * BYTES_PER_TOKEN;\n\treturn { text: parts.join("\\n"), truncated: true, originalTokens, originalLines };\n}',
	},
	{
		label: "englishProse",
		realTokens: 75,
		text: "The budget exists to stop one oversized tool result from crowding out the rest of the conversation. A result that overshoots its budget spends resident context silently, while a result truncated early says so and offers a pointer to the full text. The two failures are not symmetric, so the estimator should lean toward over-counting rather than under-counting whenever it cannot be exact.",
	},
	{
		label: "accentedProse",
		realTokens: 45,
		text: "Se ha producido un error al cargar la configuración del módulo. La operación no se pudo completar porque el archivo de configuración está dañado o no existe. Verifique la ruta especificada e inténtelo de nuevo más tarde.",
	},
	{
		label: "cjkText",
		realTokens: 45,
		text: "設定ファイルの読み込み中にエラーが発生しました。指定されたパスが存在しないか、ファイルが破損している可能性があります。もう一度お試しください。",
	},
	{
		label: "unifiedDiff",
		realTokens: 71,
		text: '@@ -20,7 +20,12 @@ export function approxTokenCount(text: string): number {\n-\treturn Math.ceil(Buffer.byteLength(text, "utf8") / 4);\n+\treturn Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);\n }\n \n export interface ImageDimensions {\n \treadonly width: number;',
	},
];

describe("approxTokenCount", () => {
	it.each(TOKENIZER_FIXTURES)("counts $label exactly", ({ realTokens, text }) => {
		expect(approxTokenCount(text)).toBe(realTokens);
	});

	// Why the dependency earns its place: these same fixtures under bytes/4 spread -48% to +31%, so no divisor served both.
	it("could not be served by any single bytes-per-token divisor", () => {
		const errorFor = (label: string) => {
			const fixture = TOKENIZER_FIXTURES.find((entry) => entry.label === label);
			if (!fixture) throw new Error(`fixture ${label} missing`);
			const bytesOverFour = Math.ceil(Buffer.byteLength(fixture.text, "utf8") / 4);
			return (bytesOverFour - fixture.realTokens) / fixture.realTokens;
		};

		expect(errorFor("lsLongListing")).toBeLessThan(-0.4);
		expect(errorFor("compactJson")).toBeLessThan(-0.25);
		expect(errorFor("searchOutput")).toBeLessThan(-0.15);
		expect(errorFor("englishProse")).toBeGreaterThan(0.2);
		expect(errorFor("cjkText")).toBeGreaterThan(0.1);
	});

	// A 200KB minified line took 10s to tokenise, so `EXACT_MAX_RUN_CHARS` estimates past 4096 chars of unbroken run.
	it("stays fast on a degenerate unbroken run and over-counts rather than under-counts it", () => {
		const degenerate = "a".repeat(200_000);
		const started = performance.now();

		const counted = approxTokenCount(degenerate);

		expect(performance.now() - started).toBeLessThan(500);
		expect(counted).toBeGreaterThan(200_000 / 6);
	});
});
