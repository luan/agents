import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, BashToolInput, LsToolInput } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Spacer, Text } from "@earendil-works/pi-tui";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";

const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const FG_BLUE = "\x1b[38;2;100;140;220m";

const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT; // tool box success/base bg — updated from theme's toolSuccessBg
let BG_ERROR = BG_DEFAULT; // tool box error bg — updated from theme's toolErrorBg

type BgTheme = { getBgAnsi?: (key: string) => string };
type FgTheme = { fg: (key: string, text: string) => string };

/** Parse an ANSI 24-bit color escape into { r, g, b }. Handles both fg (38;2) and bg (48;2). */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function getThemeBgAnsi(theme: BgTheme, key: string): string | null {
	try {
		const bgAnsi = theme.getBgAnsi?.(key);
		return bgAnsi && parseAnsiRgb(bgAnsi) ? bgAnsi : null;
	} catch {
		return null;
	}
}

/** Read themed tool backgrounds and update BG_BASE / BG_ERROR + RST.
 *  Call once when theme is first available. Idempotent. */
let _bgBaseResolved = false;
function resolveBaseBackground(theme: BgTheme | null | undefined): void {
	if (_bgBaseResolved || !theme?.getBgAnsi) return;
	_bgBaseResolved = true;

	BG_BASE = getThemeBgAnsi(theme, "toolSuccessBg") ?? BG_DEFAULT;
	BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? BG_BASE;
	RST = `\x1b[0m${BG_BASE}`;
}

function renderToolError(error: string, theme: FgTheme): string {
	return fillToolBackground(`\n${theme.fg("error", error)}`, BG_ERROR);
}

const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function preserveToolBackground(ansi: string, bg: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		const codes = params.split(";");
		return params === "0" || codes.includes("49") ? `${seq}${bg}` : seq;
	});
}

function fillToolBackground(text: string, bg = BG_BASE): string {
	const width = termW();
	return text
		.split("\n")
		.map((line) => {
			const normalized = preserveToolBackground(line, bg);
			const padding = Math.max(0, width - strip(normalized).length);
			return `${bg}${normalized}${" ".repeat(padding)}${RST}`;
		})
		.join("\n");
}

function termW(): number {
	const stderrWithColumns = process.stderr as NodeJS.WriteStream & {
		columns?: number;
	};
	const raw =
		process.stdout.columns || stderrWithColumns.columns || Number.parseInt(process.env.COLUMNS ?? "", 10) || 200;
	return Math.max(80, Math.min(raw - 4, 210));
}

function rule(w: number): string {
	return `${FG_RULE}${"─".repeat(w)}${RST}`;
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs (Seti-UI + Devicons, stable in NF v3+)
//
// Requires a Nerd Font installed (e.g., JetBrainsMono Nerd Font, FiraCode NF).
// Fallback: set PRETTY_ICONS=none to disable icons.
// ---------------------------------------------------------------------------

const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

// Nerd Font codepoints + ANSI color per file type
const NF_DIR = `${FG_BLUE}\ue5ff${RST}`; // folder
const NF_DEFAULT = `${FG_DIM}\uf15b${RST}`; // generic file

const EXT_ICON: Record<string, string> = {
	// TypeScript / JavaScript
	ts: `\x1b[38;2;49;120;198m\ue628${RST}`, // blue
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`, // react blue
	js: `\x1b[38;2;241;224;90m\ue74e${RST}`, // yellow
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`, // react cyan
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,

	// Systems / Backend
	py: `\x1b[38;2;55;118;171m\ue73c${RST}`, // python blue
	rs: `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust orange
	go: `\x1b[38;2;0;173;216m\ue724${RST}`, // go cyan
	java: `\x1b[38;2;204;62;68m\ue738${RST}`, // java red
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`, // swift orange
	rb: `\x1b[38;2;204;52;45m\ue739${RST}`, // ruby red
	kt: `\x1b[38;2;126;103;200m\ue634${RST}`, // kotlin purple
	c: `\x1b[38;2;85;154;211m\ue61e${RST}`, // c blue
	cpp: `\x1b[38;2;85;154;211m\ue61d${RST}`, // cpp blue
	h: `\x1b[38;2;140;160;185m\ue61e${RST}`, // header muted
	hpp: `\x1b[38;2;140;160;185m\ue61d${RST}`,
	cs: `\x1b[38;2;104;33;122m\ue648${RST}`, // c# purple

	// Web
	html: `\x1b[38;2;228;77;38m\ue736${RST}`, // html orange
	css: `\x1b[38;2;66;165;245m\ue749${RST}`, // css blue
	scss: `\x1b[38;2;207;100;154m\ue749${RST}`, // scss pink
	less: `\x1b[38;2;66;165;245m\ue749${RST}`,
	vue: `\x1b[38;2;65;184;131m\ue6a0${RST}`, // vue green
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`, // svelte red-orange

	// Config / Data
	json: `\x1b[38;2;241;224;90m\ue60b${RST}`, // json yellow
	jsonc: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8${RST}`, // yaml purple
	yml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml: `\x1b[38;2;160;116;196m\ue6b2${RST}`, // toml purple
	xml: `\x1b[38;2;228;77;38m\ue619${RST}`, // xml orange
	sql: `\x1b[38;2;218;218;218m\ue706${RST}`, // sql gray

	// Markdown / Docs
	md: `\x1b[38;2;66;165;245m\ue73e${RST}`, // markdown blue
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,

	// Shell / Scripts
	sh: `\x1b[38;2;137;180;130m\ue795${RST}`, // shell green
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	fish: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua: `\x1b[38;2;81;160;207m\ue620${RST}`, // lua blue
	php: `\x1b[38;2;137;147;186m\ue73d${RST}`, // php purple
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`, // dart blue

	// Images
	png: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpeg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	gif: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg: `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	ico: `\x1b[38;2;160;116;196m\uf1c5${RST}`,

	// Misc
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`, // lock gray
	env: `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`, // graphql pink
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e${RST}`, // npm green
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`, // npm gray
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628${RST}`, // ts blue
	"biome.json": `\x1b[38;2;96;165;250m\ue615${RST}`, // config blue
	".gitignore": `\x1b[38;2;222;165;132m\ue702${RST}`, // git orange
	".git": `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env": `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	".envrc": `\x1b[38;2;241;224;90m\ue615${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`, // docker blue
	makefile: `\x1b[38;2;130;130;130m\ue615${RST}`, // make gray
	gnumakefile: `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e${RST}`, // readme blue
	license: `\x1b[38;2;218;218;218m\ue60a${RST}`, // license white
	"cargo.toml": `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust
	"go.mod": `\x1b[38;2;0;173;216m\ue724${RST}`, // go
	"pyproject.toml": `\x1b[38;2;55;118;171m\ue73c${RST}`, // python
};

function fileIcon(fp: string): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = extname(fp).slice(1).toLowerCase();
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return USE_ICONS ? `${NF_DIR} ` : "";
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Render bash output with colored exit code and stderr highlighting. */
function renderBashOutput(text: string, exitCode: number | null): { summary: string; body: string } {
	const isOk = exitCode === 0;
	const statusFg = isOk ? FG_GREEN : FG_RED;
	const statusIcon = isOk ? "✓" : "✗";
	const codeStr =
		exitCode !== null ? `${statusFg}${statusIcon} exit ${exitCode}${RST}` : `${FG_YELLOW}⚡ killed${RST}`;

	const lines = text.split("\n");
	const maxShow = MAX_PREVIEW_LINES;
	const show = lines.slice(0, maxShow);
	const remaining = lines.length - maxShow;

	let body = show.join("\n");
	if (remaining > 0) {
		body += `\n${FG_DIM}  … ${remaining} more lines${RST}`;
	}

	return { summary: codeStr, body };
}

/** Render ls output as a tree view with icons. */
function renderTree(text: string, _basePath: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const out: string[] = [];
	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = show[i].trim();
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;

		// Detect directories (entries ending with /)
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon() : fileIcon(name);
		const fg = isDir ? FG_BLUE + BOLD : "";
		const reset = isDir ? RST : "";

		out.push(`${connector}${icon}${fg}${name}${reset}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`);
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
export type ToolTextContent = TextContent;
export type ToolContent = TextContent | ImageContent;
export type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails | undefined>;
type TextComponentLike = {
	setText(value: string): void;
	getText?: () => string;
};
type ComponentLike = TextComponentLike | Container;
export type TextComponentCtor = new (text?: string, x?: number, y?: number) => TextComponentLike;
type ThemeLike = BgTheme & FgTheme & { bold: (text: string) => string };
type RenderContextLike<TState extends Record<string, string | undefined> = Record<string, string | undefined>> = {
	args?: unknown;
	lastComponent?: ComponentLike;
	state: TState;
	expanded: boolean;
	showImages?: boolean;
	isError: boolean;
	isPartial?: boolean;
	toolCallId?: string;
	invalidate: () => void;
};
export type ViewImageFidelity = "readable" | "glance";
export type ViewImageParams = { path: string; fidelity?: ViewImageFidelity };
export type BashParams = BashToolInput;
export type LsParams = LsToolInput;
type RenderDetails =
	| {
			_type: "bashResult";
			text: string;
			exitCode: number | null;
			command: string;
	  }
	| { _type: "lsResult"; text: string; path: string; entryCount: number };

export function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

export function isImageContent(content: ToolContent): content is ImageContent {
	return content.type === "image";
}

export function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}
function readDisplayPath(cwd: string, filePath: string | undefined): string {
	if (!filePath) return "file";
	const absolute = resolve(cwd, filePath);
	const rel = relative(cwd, absolute);
	const withinCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));

	if (!isAbsolute(filePath) || withinCwd) return rel || ".";
	return absolute;
}

function viewImageDisplayPath(cwd: string, args: { path?: string }) {
	return readDisplayPath(cwd, args.path);
}
// 8 previews of 720x540 PNG hold under 6 MB resident; evicted entries fall back to the text note, which is what a redraw already showed before this map existed.
const RENDER_PREVIEW_LIMIT = 8;
const renderPreviews = new Map<string, ImageContent[]>();

// The 720x540 preview belongs to the terminal only, so it is parked here instead of replacing the blocks detachToolResultImages retains for the model.
export function rememberRenderPreviews(toolCallId: string, images: ImageContent[]): void {
	if (images.length === 0) return;
	renderPreviews.set(toolCallId, images);
	for (const key of renderPreviews.keys()) {
		if (renderPreviews.size <= RENDER_PREVIEW_LIMIT) break;
		renderPreviews.delete(key);
	}
}

function createTextComponent(
	TextComponent: TextComponentCtor,
	ctx: RenderContextLike,
	initialText = "",
): TextComponentLike {
	return "setText" in (ctx.lastComponent ?? {})
		? (ctx.lastComponent as TextComponentLike)
		: new TextComponent(initialText, 0, 0);
}

function renderViewImageResult(
	result: ToolResultLike,
	theme: ThemeLike,
	ctx: RenderContextLike,
	TextComponent: TextComponentCtor,
): ComponentLike {
	if (ctx.isError) {
		const text = createTextComponent(TextComponent, ctx);
		text.setText(theme.fg("error", getTextContent(result) || "Error"));
		return text;
	}

	const previews = ctx.toolCallId ? renderPreviews.get(ctx.toolCallId) : undefined;
	const imageBlocks = previews ?? result.content?.filter(isImageContent) ?? [];
	const supportsImages = Boolean(getCapabilities().images);
	if (!supportsImages || imageBlocks.length === 0) {
		const text = createTextComponent(TextComponent, ctx);
		text.setText(getTextContent(result));
		return text;
	}

	const container = new Container();
	let hasContent = false;
	for (const image of imageBlocks) {
		if (!image.data || !image.mimeType) continue;
		if (hasContent) container.addChild(new Spacer(1));
		container.addChild(
			new KittyVirtualImage(
				image.data,
				image.mimeType,
				{ fallbackColor: (text) => theme.fg("toolOutput", text) },
				{
					maxWidthCells: 80,
					maxHeightCells: 30,
					sourcePath: (image as ImageContent & { sourcePath?: string }).sourcePath,
				},
			),
		);
		hasContent = true;
	}
	return container;
}
export function supportsKittyImages(): boolean {
	return getCapabilities().images === "kitty";
}
export function loadTextComponentCtor(): TextComponentCtor {
	return Text;
}

export function createViewImagePresentation(TextComponent: TextComponentCtor, cwd: string) {
	return {
		renderShell: "self" as const,
		renderCall(args: ViewImageParams, theme: ThemeLike, ctx: RenderContextLike) {
			const text = createTextComponent(TextComponent, ctx);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("Viewed image"))} ${theme.fg("dim", "─")} ${theme.fg("dim", viewImageDisplayPath(cwd, args))}`,
			);
			return text;
		},
		renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
			return renderViewImageResult(result, theme, ctx, TextComponent);
		},
	};
}

export function createBashPresentation(TextComponent: TextComponentCtor) {
	return {
		renderCall(args: BashParams, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const cmd = args.command ?? "";
			const text = createTextComponent(TextComponent, ctx);
			const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd)}${timeout}`,
				),
			);
			return text;
		},
		renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const text = createTextComponent(TextComponent, ctx);
			if (ctx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}
			const d = result.details as RenderDetails | undefined;
			if (d?._type === "bashResult") {
				const { summary } = renderBashOutput(d.text, d.exitCode);
				const lines = d.text.split("\n");
				const lineCount = lines.length;
				const lineInfo = lineCount > 1 ? `  ${FG_DIM}(${lineCount} lines)${RST}` : "";
				const header = `  ${summary}${lineInfo}`;
				if (d.text.trim()) {
					const maxShow = ctx.expanded ? lineCount : MAX_PREVIEW_LINES;
					const show = lines.slice(0, maxShow);
					const width = termW();
					const out: string[] = [header, rule(width)];
					for (const line of show) out.push(`  ${line}`);
					out.push(rule(width));
					if (lineCount > maxShow) out.push(`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`);
					text.setText(fillToolBackground(out.join("\n")));
				} else {
					text.setText(fillToolBackground(header));
				}
				return text;
			}
			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "done";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	};
}

export function createLsPresentation(TextComponent: TextComponentCtor) {
	return {
		renderCall(args: LsParams, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const path = args.path ?? ".";
			const text = createTextComponent(TextComponent, ctx);
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path.length > 80 ? `${path.slice(0, 77)}…` : path)}`,
				),
			);
			return text;
		},
		renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const text = createTextComponent(TextComponent, ctx);
			if (ctx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}
			const d = result.details as RenderDetails | undefined;
			if (d?._type === "lsResult" && d.text) {
				const tree = renderTree(d.text, d.path);
				const info = `${FG_DIM}${d.entryCount} entries${RST}`;
				text.setText(fillToolBackground(`  ${info}\n${tree}`));
				return text;
			}
			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "listed";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	};
}
