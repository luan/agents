import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";

type ToolRenderContext<Args = Record<string, unknown>, Result = unknown> = {
	args: Args;
	cwd?: string;
	executionStarted?: boolean;
	invalidate?: () => void;
	isError?: boolean;
	isPartial?: boolean;
	lastComponent?: Component;
	result?: Result;
	state?: Record<string, unknown>;
	toolCallId?: string;
};

import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Markdown,
	type Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderCompactSummaryLine } from "../shared/compact-summary.ts";
import {
	type ExplorationReadSummaryPart,
	type ExplorationReadSummaryRow,
	getExplorationReadSummary,
	isExplorationHidden,
	type ReadActionResult,
	readAction,
	renderExplorationCall,
	renderExplorationSummaryPart,
	renderExplorationSummaryTitle,
	updateExplorationRead,
} from "../shared/exploration-rendering.ts";
import { createCircularPreviewImageFromBase64 } from "../shared/image-preview.ts";
import { KittyVirtualImage, transmitKittyInlineImageRow } from "../shared/kitty-virtual-image.ts";
import { approxTokenCount, formatTokenCount } from "../shared/output-budget.ts";
import {
	formatResourceUri,
	isResourceUri,
	parseResourceUri,
	type Resource,
	type ResourceRef,
	resourceOpenUrl,
	type SearchHit,
} from "../shared/resources.ts";
import {
	nestedRenderDetails,
	nestedRenderError,
	type RegisteredToolDefinition,
	type ToolPresentationDefinition,
} from "../shared/tool-registry.ts";
import {
	EmptyComponent,
	italic,
	keepBackgroundAcrossResets,
	paintAnsiBackgroundRow,
	RenderedLineCache,
	renderTokenCost,
	runningCellElapsedMs,
	runningFrame,
	sharedAnimationRenderAllowed,
	shouldAnimateRunningCell,
	textComponent,
} from "../shared/tui";
import {
	type CardBackgroundColor,
	darkerCardBackgroundAnsi,
	framedBlock,
	renderStatusLine,
} from "../shared/tui/card.ts";
import { createAstToolPresentation } from "./ast-tools-presentation.ts";
import {
	type DiffRenderRow,
	type DiffSectionHeaderRenderer,
	EditDiffView,
	highlightCodeRowsSync,
	highlightSearchMatches,
	languageFromPath,
	type RenderTheme,
} from "./diff-render.ts";
import {
	type EditConfig,
	type EditInput,
	type EditMode,
	editPreviewForInput,
	GITHUB_TYPE_ICON,
	type LineRange,
	type ReadSelector,
	type ResourceReadSummary,
	readCostPart,
	resourceSummaryList,
	splitReadPathSelector,
	type ToolTextResult,
} from "./execution.ts";

const EDIT_FRAME_MS = 120;
type PreviewImageDetails = {
	data: string;
	mimeType: "image/png";
	sourcePath?: string;
};

function previewImageDetails(value: unknown): PreviewImageDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.data !== "string" || candidate.mimeType !== "image/png") return undefined;
	return {
		data: candidate.data,
		mimeType: candidate.mimeType,
		sourcePath: typeof candidate.sourcePath === "string" ? candidate.sourcePath : undefined,
	};
}

export function shortenDisplayPath(path: string, cwd = process.cwd()): string {
	const normalized = path.replace(/\\/g, "/");
	if (isResourceUri(normalized)) return normalized;
	const expanded =
		normalized === "~" ? homedir() : normalized.startsWith("~/") ? join(homedir(), normalized.slice(2)) : normalized;
	const root = resolve(cwd);
	const absolute = resolve(root, expanded);
	const projectRelative = relative(root, absolute).replace(/\\/g, "/");
	if (
		projectRelative === "" ||
		(!projectRelative.startsWith("../") && projectRelative !== ".." && !isAbsolute(projectRelative))
	) {
		return projectRelative || ".";
	}
	const home = resolve(homedir());
	const homeRelative = relative(home, absolute).replace(/\\/g, "/");
	if (absolute === home) return "~";
	if (!homeRelative.startsWith("../") && homeRelative !== ".." && !isAbsolute(homeRelative))
		return `~/${homeRelative}`;
	return absolute;
}

function tokenCostLabel(theme: RenderTheme, text: string, toolName: string): string {
	return renderTokenCost(theme, approxTokenCount(text), toolName);
}

function firstTextContent(result: ToolTextResult): string {
	const part = result.content.find((item): item is { type: "text"; text: string } => item.type === "text");
	return part?.text ?? "";
}
function halfBackground(line: string, glyph: "▄" | "▀", width: number): string {
	const background = line.match(/\x1b\[48(?:;[0-9]+)*m/)?.[0];
	return background ? `${background.replace("[48", "[38")}${glyph.repeat(width)}\x1b[39m` : line;
}
type AvatarImageData = { base64Data: string; mimeType: string; sourcePath?: string };
const avatarImageCache = new Map<string, Promise<AvatarImageData | undefined>>();
/** Settled, so a rebuilt `InlineAvatar` needs no microtask and arms no invalidate. That loop held 92% CPU. */
const settledAvatarImages = new Map<string, AvatarImageData | undefined>();

function cachedAvatarImage(url: string): Promise<AvatarImageData | undefined> {
	const cached = avatarImageCache.get(url);
	if (cached) return cached;
	const pending = fetch(url, { signal: AbortSignal.timeout(5_000) })
		.then(async (response) => {
			if (!response.ok) return undefined;
			const mimeType = (response.headers.get("content-type") ?? "image/png").split(";", 1)[0] ?? "image/png";
			if (!mimeType.startsWith("image/")) return undefined;
			const base64Data = Buffer.from(await response.arrayBuffer()).toString("base64");
			const preview = await createCircularPreviewImageFromBase64(base64Data, mimeType);
			if (preview) return { base64Data: preview.data, mimeType: preview.mimeType, sourcePath: preview.sourcePath };
			return mimeType === "image/png" ? { base64Data, mimeType } : undefined;
		})
		.catch(() => undefined);
	avatarImageCache.set(url, pending);
	void pending.then((data) => settledAvatarImages.set(url, data));
	return pending;
}

class InlineAvatar {
	private base64Data?: string;
	private sourcePath?: string;
	private placeholder?: string;

	constructor(url: string, onInvalidate: () => void) {
		if (settledAvatarImages.has(url)) {
			this.adopt(settledAvatarImages.get(url));
			return;
		}
		void cachedAvatarImage(url).then((data) => {
			if (!data) return;
			this.adopt(data);
			onInvalidate();
		});
	}

	private adopt(data: AvatarImageData | undefined): void {
		if (!data) return;
		this.base64Data = data.base64Data;
		this.sourcePath = data.sourcePath;
		this.placeholder = undefined;
	}

	render(): string {
		if (getCapabilities().images !== "kitty" || !this.base64Data) return "";
		if (this.placeholder) return this.placeholder;
		this.placeholder = transmitKittyInlineImageRow(this.base64Data, 2, this.sourcePath);
		return this.placeholder;
	}
}

class ResourceSummaryCard implements Component {
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		private readonly box: Box,
		private readonly theme: RenderTheme,
		private readonly visible: () => boolean,
	) {}

	render(width: number): string[] {
		if (!this.visible()) return [];
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		const background =
			darkerCardBackgroundAnsi(this.theme, "toolPendingBg") ?? this.theme.bg?.("toolPendingBg", " ").split(" ")[0];
		const lines = this.box.render(width).map((line) => paintAnsiBackgroundRow(line, width, background));
		if (lines.length >= 2) {
			lines[0] = halfBackground(lines[0]!, "▄", width);
			lines[lines.length - 1] = halfBackground(lines.at(-1)!, "▀", width);
		}
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.box.invalidate();
	}
}

function renderResourceSummaryPart(
	part: ExplorationReadSummaryPart,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
): string {
	const avatar = avatarFor(part.avatarUrl);
	return `${avatar ? `${avatar} ` : ""}${renderExplorationSummaryPart(part, theme)}`;
}

function renderResourceSummaryMeta(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
): string {
	const parts = [
		...(summary.metaParts ?? (summary.meta ? [{ text: summary.meta }] : [])),
		...(summary.uri ? [summary.uri] : []),
	];
	if (parts.length === 0) return "";
	const separator = theme.fg("dim", " · ");
	return ` ${theme.fg("dim", "·")} ${parts.map((part) => renderResourceSummaryPart(part, theme, avatarFor)).join(separator)}`;
}

function renderResourceSummaryRow(
	row: ExplorationReadSummaryRow,
	index: number,
	total: number,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
	width?: number,
): string {
	const branch = row.branch === false ? "" : theme.fg("dim", `${index === total - 1 ? "└─" : "├─"} `);
	const leading = row.leading
		? row.leading.trim()
			? theme.fg(row.leadingRole ?? "muted", row.leading)
			: row.leading
		: "";
	const avatar = avatarFor(row.avatarUrl);
	const icon = row.icon ? `${theme.fg(row.iconRole ?? "muted", row.icon)} ` : "";
	const rowPrefix = row.prefix ? `${renderResourceSummaryPart(row.prefix, theme, avatarFor)} ` : "";
	const rowText = row.italic ? italic(row.text) : row.text;
	const styledRowText = row.bold ? theme.bold(rowText) : rowText;
	const body = row.textUrl
		? renderExplorationSummaryPart({ text: styledRowText, role: row.textRole, url: row.textUrl }, theme)
		: theme.fg(row.textRole ?? "muted", styledRowText);
	const details = row.details
		?.map((part) => renderResourceSummaryPart(part, theme, avatarFor))
		.join(theme.fg("dim", " · "));
	const prefix = `${branch}${leading}${avatar ? `${avatar} ` : ""}${icon}${rowPrefix}${body}${details ? `${theme.fg("dim", " · ")}${details}` : ""}`;
	const status = row.status ? renderResourceSummaryPart(row.status, theme, avatarFor) : "";
	if (!status) return prefix;
	if (width === undefined) return `${prefix} ${status}`;
	const bodyWidth = Math.max(1, width - visibleWidth(status) - 1);
	const clippedPrefix = truncateToWidth(prefix, bodyWidth);
	return `${clippedPrefix}${" ".repeat(Math.max(1, width - visibleWidth(clippedPrefix) - visibleWidth(status)))}${status}`;
}
function resourceSummaryHeaderLines(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	avatarFor: (url: string | undefined) => string,
	width: number,
): string[] {
	const subtitle = `${renderExplorationSummaryPart(
		{ text: summary.subtitle, role: "mdLink", url: summary.subtitleUrl },
		theme,
	)}${renderResourceSummaryMeta(summary, theme, avatarFor)}`;
	const subtitleStatus = summary.subtitleStatus
		? `${theme.fg(summary.subtitleStatus.iconRole, summary.subtitleStatus.icon)} ${theme.fg(
				summary.subtitleStatus.iconRole,
				summary.subtitleStatus.label,
			)}`
		: "";
	const subtitleLine = subtitleStatus
		? (mergeResourceColumns([subtitle], [` ${subtitleStatus}`], width)?.[0] ?? subtitle)
		: subtitle;
	if (summary.typeIcon) {
		const summaryLine = renderExplorationSummaryTitle(summary, theme, true);
		const author = summary.author ? renderResourceSummaryPart(summary.author, theme, avatarFor) : "";
		if (!author) return [summaryLine, subtitleLine];
		const authorLine = mergeResourceColumns([summaryLine], [` ${author}`], width)?.[0];
		if (authorLine) return [authorLine, subtitleLine];
		const right = truncateToWidth(author, Math.max(1, width - 2));
		const left = truncateToWidth(summaryLine, Math.max(1, width - visibleWidth(right) - 1));
		return [
			`${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`,
			subtitleLine,
		];
	}
	if (summary.scheme === "history") {
		return [
			renderCompactSummaryLine(theme, {
				icon: summary.icon,
				label: summary.label,
				name: summary.title,
			}),
			subtitleLine,
		];
	}
	return [
		renderCompactSummaryLine(theme, {
			icon: summary.icon,
			label: summary.label,
			name: summary.title,
			path: summary.subtitle,
			meta: summary.meta,
			pathUrl: summary.subtitleUrl,
		}),
	];
}

function padResourceLine(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function resourceRightColumnWidth(width: number): number {
	return Math.min(42, Math.max(24, Math.floor(width * 0.32)));
}

function mergeResourceColumns(left: string[], right: string[], width: number): string[] | undefined {
	const rightWidth = resourceRightColumnWidth(width);
	const leftWidth = width - rightWidth - 3;
	if (leftWidth < 36) return undefined;
	const lines: string[] = [];
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const leftLine = padResourceLine(left[index] ?? "", leftWidth);
		const rightLine = right[index] ?? "";
		lines.push(truncateToWidth(`${leftLine}  ${rightLine}`, width));
	}
	return lines;
}

/**
 * The body of a bare read gets at least this many lines before it is cut.
 *
 * The card is as tall as its tallest column, so a body cut at ten lines beside
 * a twenty-row check column left ten lines of empty card and lost text for
 * nothing. Ten is the floor, the side column raises it.
 */
const RESOURCE_BODY_MIN_LINES = 10;

/** A listing row's body: enough to read the point, not the whole comment. */
const RESOURCE_ROW_BODY_MAX_LINES = 6;

class ResourceSummaryText implements Component {
	private readonly avatars = new Map<string, InlineAvatar>();
	private readonly markdown?: Markdown;
	// Keyed by row identity so a re-render reuses the same instance.
	private readonly rowMarkdown = new Map<ExplorationReadSummaryRow, Markdown>();

	constructor(
		private readonly summary: ResourceReadSummary,
		private readonly theme: RenderTheme,
		onInvalidate: () => void,
	) {
		const markdownFor = (text: string) =>
			new Markdown(text, 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });
		this.markdown = summary.markdown ? markdownFor(summary.markdown) : undefined;
		for (const row of summary.rows ?? []) if (row.markdown) this.rowMarkdown.set(row, markdownFor(row.markdown));
		if (getCapabilities().images !== "kitty") return;
		const addAvatar = (url: string | undefined) => {
			if (url && !this.avatars.has(url)) this.avatars.set(url, new InlineAvatar(url, onInvalidate));
		};
		for (const part of summary.metaParts ?? []) addAvatar(part.avatarUrl);
		addAvatar(summary.author?.avatarUrl);
		for (const row of [...(summary.rows ?? []), ...(summary.sideRows ?? [])]) {
			addAvatar(row.avatarUrl);
			for (const detail of row.details ?? []) addAvatar(detail.avatarUrl);
			addAvatar(row.status?.avatarUrl);
		}
	}

	render(width: number): string[] {
		const avatarFor = (url: string | undefined) => (url ? (this.avatars.get(url)?.render() ?? "") : "");
		const header = resourceSummaryHeaderLines(this.summary, this.theme, avatarFor, width).map((line) => ` ${line}`);
		const rows = this.summary.rows ?? [];
		const footer = rows.filter((row) => row.footer);
		const visibleRows = rows.filter((row) => !row.footer);
		const rightWidth = resourceRightColumnWidth(width);
		const right = (this.summary.sideRows ?? []).map(
			(row, index, sideRows) =>
				` ${renderResourceSummaryRow(row, index, sideRows.length, this.theme, avatarFor, Math.max(1, rightWidth - 1))}`,
		);
		const leftWidth = width - rightWidth - 3;
		const markdownWidth = right.length > 0 && leftWidth >= 36 ? leftWidth - 1 : width - 2;
		const left = visibleRows.flatMap((row, index) => {
			const line = ` ${renderResourceSummaryRow(row, index, visibleRows.length, this.theme, avatarFor)}`;
			const body = this.rowMarkdown.get(row);
			if (!body) return [line];
			const rendered = body
				.render(Math.max(1, markdownWidth - 3))
				.slice(0, RESOURCE_ROW_BODY_MAX_LINES)
				.map((bodyLine) => `   ${bodyLine}`);
			return [line, ...rendered];
		});
		const renderedMarkdown = this.markdown?.render(Math.max(1, markdownWidth)) ?? [];
		const bodyBudget = Math.max(RESOURCE_BODY_MIN_LINES, right.length - left.length);
		const markdown = renderedMarkdown.slice(0, bodyBudget).map((line) => ` ${line}`);
		if (renderedMarkdown.length > markdown.length) markdown.push(` ${this.theme.fg("muted", "… body truncated")}`);
		const leftColumn = [...markdown, ...left];
		const body =
			right.length === 0
				? leftColumn
				: (mergeResourceColumns(leftColumn, right, width) ?? [...right, ...leftColumn]);
		const footerLines = footer.map(
			(row, index) => ` ${renderResourceSummaryRow(row, index, footer.length, this.theme, avatarFor)}`,
		);
		return [...header, ...body, ...footerLines];
	}

	invalidate(): void {
		this.markdown?.invalidate();
		for (const markdown of this.rowMarkdown.values()) markdown.invalidate();
	}
}

function renderResourceSummaryCard(
	summary: ResourceReadSummary,
	theme: RenderTheme,
	invalidate: () => void = () => {},
	visible: () => boolean = () => true,
): Component {
	const displaySummary = summary.statusSuffix ? { ...summary, statusSuffix: italic(summary.statusSuffix) } : summary;
	const box = new Box(1, 1, (text) => text);
	box.addChild(
		new ResourceSummaryText(displaySummary, theme, () => {
			box.invalidate();
			invalidate();
		}),
	);
	return new ResourceSummaryCard(box, theme, visible);
}
function resourceLoadingIcon(scheme: ResourceRef["scheme"]): string {
	if (scheme === "pr" || scheme === "issue") return GITHUB_TYPE_ICON;
	if (scheme === "history") return "";
	if (scheme === "vault") return "󱔗";
	if (scheme === "skill") return "";
	return "≡";
}

function renderResourceLoading(
	operation: "read" | "search" | "find",
	path: string,
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component | undefined {
	let ref: ResourceRef | undefined;
	try {
		ref = parseResourceUri(path);
	} catch {
		return undefined;
	}
	if (!ref) return undefined;
	const identity = `resource:${operation}:${formatResourceUri(ref)}`;
	if (context?.lastComponent instanceof BlockTextView && context.lastComponent.matches(identity))
		return context.lastComponent;
	const label = operation === "read" ? "reading" : operation === "search" ? "searching" : "finding";
	const frame = () => runningFrame(streamingElapsedMs(context, true), EDIT_FRAME_MS);
	return new BlockTextView(
		() => {
			scheduleStreamingInvalidation(context, true);
			const uri = formatResourceUri(ref);
			const renderedUri = renderExplorationSummaryPart(
				{ text: uri, role: "mdLink", italic: true, url: resourceOpenUrl(uri, { cwd: context?.cwd }) },
				theme,
			);
			return `${theme.fg("text", resourceLoadingIcon(ref.scheme))}  ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("warning", frame())} ${renderedUri}`;
		},
		theme,
		() => context?.isPartial === true,
		frame,
		null,
		identity,
	);
}

class ResourceReadCardView implements Component {
	private card?: Component;
	private cardSummary?: ResourceReadSummary;
	private resolvedSummary?: ResourceReadSummary;
	private cardInitialized = false;

	constructor(
		private readonly displayPath: string,
		private readonly loading: Component,
		private readonly theme: RenderTheme,
		private context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	) {}
	matches(displayPath: string): boolean {
		return this.displayPath === displayPath;
	}

	/** `nestedContext` builds a new context per pass; the first one said `isPartial: true` and this view kept it. */
	refresh(context: Partial<ToolRenderContext<Record<string, unknown>, unknown>> | undefined): void {
		this.context = context;
	}
	setSummary(summary: ResourceReadSummary): void {
		// Identity, not deep equality: a rebuilt card re-arms the `InlineAvatar` invalidate that renders it again.
		if (this.resolvedSummary === summary) return;
		this.resolvedSummary = summary;
		this.cardInitialized = false;
		this.invalidate();
	}

	render(width: number): string[] {
		const call = renderExplorationCall(readAction(this.displayPath, this.context?.cwd), this.theme, this.context);
		if (isExplorationHidden(this.context?.toolCallId)) return [];
		const summary = this.resolvedSummary ?? getExplorationReadSummary(this.context?.toolCallId);
		// A settled replay may omit resourceSummary from projected details; show canonical path instead of spinning loading.
		if (!summary) {
			if (this.context?.isPartial === true) return this.loading.render(width);
			// Persisted nested read details omit resourceSummary; keep settled replay clickable without a fake fallback row.
			return call ? call.split("\n") : [];
		}
		if (!this.cardInitialized || this.cardSummary !== summary) {
			const resourceSummary = summary as ResourceReadSummary;
			this.cardSummary = resourceSummary;
			this.card = renderResourceSummaryCard(resourceSummary, this.theme, this.context?.invalidate ?? (() => {}));
			this.cardInitialized = true;
		}
		return this.card?.render(width) ?? [];
	}

	invalidate(): void {
		this.loading.invalidate();
		this.card?.invalidate();
	}
}

function renderResourceReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: RenderTheme,
	toolCallId?: string,
	invalidate: () => void = () => {},
	lastComponent?: Component,
): Component | undefined {
	const summary = result.details?.resourceSummary;
	if (!summary || typeof summary !== "object") return undefined;
	const typedSummary = summary as ResourceReadSummary;
	const readCard = lastComponent instanceof ResourceReadCardView ? lastComponent : undefined;
	readCard?.setSummary(typedSummary);
	const inExploration = updateExplorationRead(toolCallId, typedSummary);
	const expanded = options.expanded
		? renderPlainReadResult(firstTextContent(result), result, { expanded: true }, theme)
		: EMPTY_VIEW;
	// `renderReadCall` owns the card whenever the registry holds the call. The `expanded` case drew a second one.
	if (inExploration) return expanded;
	const card = readCard ?? renderResourceSummaryCard(typedSummary, theme, invalidate);
	if (expanded === EMPTY_VIEW) return card;
	const container = new Container();
	container.addChild(card);
	container.addChild(expanded);
	return container;
}

function renderText(text: string): Text {
	return textComponent(text);
}

const EMPTY_TOOL_CALL_IDS = new Set<string>();

const EMPTY_VIEW = new EmptyComponent();

class BlockTextView {
	private readonly cache = new RenderedLineCache();

	constructor(
		private readonly text: string | ((width: number) => string),
		private readonly theme: RenderTheme,
		private readonly shouldRender: () => boolean = () => true,
		private readonly key: () => string = () => "",
		private readonly backgroundRole: string | null = "toolPendingBg",
		private readonly identity?: string,
	) {}

	matches(identity: string): boolean {
		return this.identity === identity;
	}

	invalidate() {
		this.cache.clear();
	}

	render(width: number): string[] {
		if (!this.shouldRender()) return [];
		return this.cache.get(width, this.key(), () => {
			const text = typeof this.text === "function" ? this.text(width) : this.text;
			if (!this.backgroundRole) return textComponent(text).render(width);
			const box = new Box(0, 0, paintToolBackground(this.theme, this.backgroundRole));
			box.addChild(textComponent(text));
			return box.render(width);
		});
	}
}

function toolTextLines(text: string): string[] {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

function invalidArgText(theme: RenderTheme): string {
	return theme.fg("error", "[invalid]");
}

function treeLast(theme: RenderTheme): string {
	return theme.tree?.last ?? "└─";
}

function treeBranch(theme: RenderTheme): string {
	return theme.tree?.branch ?? "├─";
}

function fileIcon(theme: RenderTheme, filePath?: string): string {
	return theme.getLangIcon?.(languageFromPath(filePath)) ?? "≡";
}

function statusIcon(theme: RenderTheme, icon: "success" | "error" | "warning" | "pending"): string {
	return (
		theme.styledSymbol?.(`status.${icon}`, icon === "pending" ? "muted" : icon) ??
		(icon === "success" ? "✓" : icon === "error" ? "✗" : icon === "warning" ? "!" : "∙")
	);
}

function renderStatusHeader(
	label: string,
	theme: RenderTheme,
	rest = "",
	icon: "success" | "error" | "warning" | "pending" = "success",
): string {
	return `${statusIcon(theme, icon)} ${theme.fg("toolTitle", theme.bold(label))}${rest}`;
}

type StreamingRenderContext = {
	state?: Record<string, unknown> & { elapsedTimer?: ReturnType<typeof setTimeout> };
	isPartial?: boolean;
	expanded?: boolean;
	invalidate?: () => void;
};

function streamingElapsedMs(context: StreamingRenderContext | undefined, running: boolean): number | undefined {
	return runningCellElapsedMs(context?.state, running);
}

function scheduleStreamingInvalidation(context: StreamingRenderContext | undefined, running: boolean): void {
	const state = context?.state;
	if (!state) return;
	const timer = state.elapsedTimer as ReturnType<typeof setTimeout> | undefined;
	if (!shouldAnimateRunningCell(state, running)) {
		if (timer) {
			clearTimeout(timer);
			state.elapsedTimer = undefined;
		}
		return;
	}
	if (timer || !context?.invalidate) return;
	state.elapsedTimer = setTimeout(() => {
		state.elapsedTimer = undefined;
		if (sharedAnimationRenderAllowed()) context.invalidate?.();
	}, EDIT_FRAME_MS);
	state.elapsedTimer.unref?.();
}

function streamingStatusLine(theme: RenderTheme, context: StreamingRenderContext | undefined, label: string): string {
	return `${theme.fg("dim", runningFrame(streamingElapsedMs(context, true), EDIT_FRAME_MS))} ${theme.fg("dim", `(${label})`)}`;
}

function paintToolBackground(theme: RenderTheme, role: string): ((line: string) => string) | undefined {
	const backgroundAnsi = theme.getBgAnsi?.(role);
	if (backgroundAnsi) return (line) => `${backgroundAnsi}${keepBackgroundAcrossResets(line, backgroundAnsi)}\x1b[0m`;
	return theme.bg ? (line) => theme.bg?.(role, line) ?? line : undefined;
}

function cardBackgroundAnsi(theme: RenderTheme, role: CardBackgroundColor): string | undefined {
	return darkerCardBackgroundAnsi(theme, role);
}

function formatLineRange(range: LineRange): string {
	if (range.start === range.end) return String(range.start);
	return `${range.start}-${Number.isFinite(range.end) ? range.end : ""}`;
}

function formatReadLineRange(args: { path?: string }): string {
	if (typeof args.path !== "string") return "";
	const selector = splitReadPathSelector(args.path);
	const parts = [
		...(selector.ranges.length > 0 ? [selector.ranges.map(formatLineRange).join(",")] : []),
		...(selector.conflicts ? ["conflicts"] : []),
		...(selector.raw ? ["raw"] : []),
	];
	return parts.length > 0 ? `:${parts.join(":")}` : "";
}

function renderNumberedRows(
	rows: readonly string[],
	theme: RenderTheme,
	limit: number,
	highlightedRows: readonly string[] = [],
): string {
	const output: string[] = [];
	const displayed = rows.slice(0, limit);
	for (const [index, row] of displayed.entries()) {
		const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
		if (!match) {
			output.push(theme.fg("toolOutput", row));
			continue;
		}
		const marker = match[1] === "*" ? "*" : " ";
		const lineNumber = match[2]?.padStart(3, " ") ?? "";
		const fallbackBody = theme.fg("toolOutput", match[3] ?? "");
		const body = highlightedRows[index] ?? fallbackBody;
		output.push(`${theme.fg("dim", `${marker}${lineNumber}│`)}${body}`);
	}
	if (rows.length > limit)
		output.push(
			theme.fg("muted", `... (${rows.length - limit} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return output.join("\n");
}

type HashlineRenderSection = {
	header: string;
	path: string;
	rows: string[];
	diagnostics: string[];
};

function parseHashlineSections(text: string): HashlineRenderSection[] {
	const sections: HashlineRenderSection[] = [];
	let current: HashlineRenderSection | undefined;
	for (const line of toolTextLines(text)) {
		const header = /^(\[(.+?)#[0-9A-Fa-f]{4}\])$/.exec(line);
		if (header) {
			current = { header: header[1] ?? line, path: header[2] ?? "", rows: [], diagnostics: [] };
			sections.push(current);
			continue;
		}
		if (!current || line.length === 0) continue;
		if (
			line.startsWith("Use a narrower path") ||
			/^\[(?:Search results truncated|Find results truncated|\d+ more lines in (?:file|resource))/.test(line)
		) {
			current.diagnostics.push(line);
		} else if (!line.startsWith("[")) {
			current.rows.push(line);
		}
	}
	return sections;
}

function renderHashlineHeader(header: string, theme: RenderTheme): string {
	const match = /^(\[.+?)(#[0-9A-Fa-f]{4}\])?$/.exec(header);
	if (!match) return theme.fg("accent", header);
	return `${theme.fg("accent", match[1] ?? "")}${match[2] ? theme.fg("toolDiffAdded", match[2]) : ""}`;
}

function readDisplaySelector(path: string): ReadSelector | undefined {
	try {
		return splitReadPathSelector(path);
	} catch {
		return undefined;
	}
}

function readDisplay(params: { path?: string }, cwd = process.cwd()): string {
	if (typeof params.path !== "string") return "[invalid]";
	const selector = readDisplaySelector(params.path);
	const path = selector?.path ?? params.path;
	return path
		? `${shortenDisplayPath(path.replace(/\\/g, "/"), cwd)}${selector ? formatReadLineRange(params) : ""}`
		: "[invalid]";
}

/**
 * The read's own numbers, for the row that announced it.
 *
 * Only reachable for a call a cell made: pi hands a top-level read's result to
 * `renderResult`, but a nested call has no result renderer at all, so what the
 * read cost travels on the render context instead. Everything here is read
 * defensively because `details` is clipped on the way — a card that shows one
 * number less is fine, a card that throws takes the whole cell down with it.
 */
function readResultParts(details: Record<string, unknown> | undefined): ReadActionResult | undefined {
	if (!details) return undefined;
	const outputTokens = typeof details.outputTokens === "number" ? details.outputTokens : undefined;
	const cost = outputTokens === undefined ? undefined : readCostPart(outputTokens, details.outputBounded === true);
	const summary = details.summary;
	if (!summary || typeof summary !== "object") return cost ? { cost } : undefined;
	const { totalLines, elidedLines, fullTokens } = summary as Record<string, unknown>;
	if (typeof totalLines !== "number" || typeof elidedLines !== "number") return cost ? { cost } : undefined;
	// One part, not three. The row's subject is the path and its headline is the
	// cost on the title line above; what the summary elided and what a whole read
	// would have cost are the footnote that justifies both. Three parts made three
	// dot-separated fragments of equal weight next to the path, so they read as
	// four competing facts; one dim italic clause reads as an aside, which is what
	// it is.
	const full = typeof fullTokens === "number" ? `, full read ${formatTokenCount(fullTokens)} tok` : "";
	return {
		cost,
		details: [
			{
				text: `structural summary, ${elidedLines.toLocaleString()} of ${totalLines.toLocaleString()} lines elided${full}`,
				role: "dim",
				italic: true,
			},
		],
	};
}

function renderReadCall(
	params: { path?: string },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	const rawPath = typeof params.path === "string" ? readDisplaySelector(params.path)?.path : undefined;
	const displayPath = readDisplay(params, context?.cwd ?? process.cwd());
	if (rawPath && isResourceUri(rawPath)) {
		if (context?.isError === true) return EMPTY_VIEW;
		if (context?.lastComponent instanceof ResourceReadCardView && context.lastComponent.matches(displayPath)) {
			context.lastComponent.refresh(context);
			return context.lastComponent;
		}
		const loading = renderResourceLoading("read", rawPath, theme, context);
		if (!loading) return EMPTY_VIEW;
		const view = new ResourceReadCardView(displayPath, loading, theme, context);
		const summary = nestedRenderDetails(context)?.resourceSummary;
		if (summary && typeof summary === "object" && !Array.isArray(summary))
			view.setSummary(summary as ResourceReadSummary);
		return view;
	}
	const result = readResultParts(nestedRenderDetails(context));
	return new BlockTextView(
		() => renderExplorationCall(readAction(displayPath, context?.cwd, result), theme, context),
		theme,
	);
}

function renderPlainReadResult(
	text: string,
	result: ToolTextResult,
	options: { expanded?: boolean },
	theme: RenderTheme,
): Text | EmptyComponent {
	const lines = toolTextLines(text);
	// A binary notice is two lines and is the whole answer, so it shows without
	// being expanded; everything else stays behind the expand hint.
	const notice = result.details?.readKind === "binary";
	if (lines.length === 0 || (!options.expanded && !notice)) return EMPTY_VIEW;
	return renderText(lines.map((line) => theme.fg(notice ? "warning" : "toolOutput", line)).join("\n"));
}

function renderReadResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean; isError?: boolean },
	theme: RenderTheme,
	toolCallId?: string,
	invalidate: () => void = () => {},
	lastComponent?: Component,
): Component {
	if (options.isPartial) return EMPTY_VIEW;
	if (options.isError) return renderText(theme.fg("error", firstTextContent(result).trim() || "Read failed."));
	const resource = renderResourceReadResult(result, options, theme, toolCallId, invalidate, lastComponent);
	if (resource) return resource;
	const preview = previewImageDetails(result.details?.previewImage);
	// A file read draws no body at all, expanded or not. The row above it already
	// names the file, what the read cost and what it elided, and the one state
	// ctrl+o used to reveal was several hundred lines of the file pasted back
	// into the transcript — the exact cost the summary exists to avoid.
	if (!preview) return renderPlainReadResult(firstTextContent(result), result, { expanded: false }, theme);

	const container = new Container();
	const text = firstTextContent(result).trim();
	if (text) container.addChild(textComponent(theme.fg("toolOutput", text)));
	container.addChild(
		new KittyVirtualImage(
			preview.data,
			preview.mimeType,
			{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
			{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
		),
	);
	return container;
}

function resourceDetailsList(result: ToolTextResult, key: string): Resource[] {
	const value = result.details?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Resource =>
			Boolean(item) && typeof item === "object" && typeof (item as Resource).uri === "string",
	);
}

function renderResourceListCard(
	resources: readonly Resource[],
	operation: "find" | "search",
	subtitle: string,
	theme: RenderTheme,
	visible: () => boolean,
	snippets: readonly (string | undefined)[] = [],
): Component | undefined {
	const summary = resourceSummaryList(resources, operation, subtitle, snippets);
	return summary ? renderResourceSummaryCard(summary, theme, () => {}, visible) : undefined;
}

function searchPathDisplay(path: unknown, cwd: string): string {
	if (typeof path !== "string") return ".";
	let selected = path;
	try {
		selected = splitReadPathSelector(path).path;
	} catch {}
	const display = shortenDisplayPath(selected, cwd);
	return display.length > 96 ? `${display.slice(0, 93)}...` : display;
}
function searchFailureReason(reason: string, cwd: string): string {
	const text = reason.replaceAll(cwd, ".").replace(/\s+/g, " ").trim();
	return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}
function renderSearchError(
	args: { pattern?: unknown; path?: unknown },
	reason: string,
	theme: RenderTheme,
	visible: () => boolean,
	cwd = process.cwd(),
): Component {
	const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "(missing pattern)";
	const target = searchPathDisplay(args.path, cwd);
	return framedBlock(theme, {
		header: renderStatusHeader(
			"Search failed:",
			theme,
			` ${theme.fg("warning", pattern)} ${theme.fg("dim", `in ${target}`)}`,
			"error",
		),
		sections: [{ lines: [theme.fg("error", searchFailureReason(reason || "Search failed.", cwd))] }],
		borderColor: "error",
		backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
		visible,
	});
}
function renderSearchCall(
	params: { pattern?: unknown; path?: unknown },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	if (context?.isError === true) {
		return renderSearchError(
			params,
			nestedRenderError(context) ?? "Search failed.",
			theme,
			() => true,
			context.cwd ?? process.cwd(),
		);
	}
	if (context?.isPartial !== true || typeof params.path !== "string" || !isResourceUri(params.path)) return EMPTY_VIEW;
	return renderResourceLoading("search", params.path, theme, context) ?? EMPTY_VIEW;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchText(text: string, pattern: string, theme: RenderTheme): string {
	if (!pattern) return theme.fg("toolOutput", text);
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "gi");
	} catch {
		regex = new RegExp(escapeRegExp(pattern), "gi");
	}
	return theme
		.fg("toolOutput", text)
		.replace(regex, (match) =>
			match.length === 0 ? match : (theme.inverse?.(match) ?? theme.fg("toolDiffAdded", match)),
		);
}

function renderSearchRow(row: string, pattern: string, theme: RenderTheme, highlightedBody?: string): string {
	const match = /^([ *]?)([1-9]\d*):(.*)$/.exec(row);
	if (!match) return theme.fg("toolOutput", row);
	const marker = match[1] === "*" ? "*" : " ";
	const lineNumber = match[2]?.padStart(3, " ") ?? "";
	const body = highlightedBody ?? highlightSearchText(match[3] ?? "", pattern, theme);
	const gutterRole = marker === "*" ? "toolDiffAdded" : "dim";
	return `${theme.fg(gutterRole, `${marker}${lineNumber}│`)}${body}`;
}
function renderSearchSections(
	sections: readonly HashlineRenderSection[],
	theme: RenderTheme,
	expanded: boolean,
	pattern: string,
	cwd: string,
): string {
	const lines: string[] = [];
	const maxRows = expanded ? Number.POSITIVE_INFINITY : 12;
	let emittedRows = 0;
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		if (emittedRows >= maxRows) break;
		const section = sections[sectionIndex];
		const bodies = section.rows.map((row) => /^([ *]?)([1-9]\d*):(.*)$/.exec(row)?.[3] ?? row);
		const highlightedRows = highlightCodeRowsSync(section.path, bodies);
		const isLastSection = sectionIndex === sections.length - 1;
		const branch = isLastSection ? treeLast(theme) : treeBranch(theme);
		const continuation = isLastSection ? "   " : `${theme.tree?.vertical ?? "│"}  `;
		const linkedPath = renderExplorationSummaryPart(
			{ text: section.path, role: "mdLink", url: pathToFileURL(resolve(cwd, section.path)).href },
			theme,
		);
		lines.push(`${theme.fg("dim", `${branch} ${fileIcon(theme, section.path)} `)}${linkedPath}`);
		for (const [rowIndex, row] of section.rows.entries()) {
			if (emittedRows >= maxRows) break;
			const isMatch = row.startsWith("*");
			const highlighted = highlightedRows[rowIndex];
			lines.push(
				`${theme.fg("dim", continuation)}${renderSearchRow(
					row,
					pattern,
					theme,
					isMatch && highlighted ? highlightSearchMatches(highlighted, pattern) : highlighted,
				)}`,
			);
			emittedRows++;
		}
		for (const diagnostic of section.diagnostics)
			lines.push(`${theme.fg("dim", continuation)}${theme.fg("muted", diagnostic)}`);
	}
	const totalRows = sections.reduce((count, section) => count + section.rows.length, 0);
	if (totalRows > emittedRows)
		lines.push(
			theme.fg("muted", `... (${totalRows - emittedRows} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	return lines.join("\n");
}
function renderSearchResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { pattern?: unknown; path?: unknown },
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	latestTurnToolCallIds: ReadonlySet<string> = EMPTY_TOOL_CALL_IDS,
	getLatestTurnIndex: () => number | undefined = () => undefined,
): Component {
	const shouldRender = () =>
		shouldRenderLatestToolResult(result, context, latestTurnToolCallIds, getLatestTurnIndex());
	if (!shouldRender()) return EMPTY_VIEW;
	const pattern = typeof args?.pattern === "string" ? args.pattern : "";
	if (context?.isError === true) {
		return renderSearchError(args ?? {}, firstTextContent(result), theme, shouldRender, context.cwd ?? process.cwd());
	}
	const noMatchPath = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : ".";
	if (options.isPartial) {
		return framedBlock(theme, {
			header: renderStatusHeader("Search", theme, ` ${theme.fg("warning", pattern)}`, "pending"),
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: shouldRender,
		});
	}
	const resources = resourceDetailsList(result, "resources");
	if (resources.length > 0) {
		const resourceCard = renderResourceListCard(
			resources,
			"search",
			`query: ${pattern} · scope: ${shortenDisplayPath(noMatchPath)}`,
			theme,
			shouldRender,
			resources.map((resource) => (resource as SearchHit).snippet),
		);
		if (resourceCard) return resourceCard;
	}
	const text = firstTextContent(result).trim();
	if (/^No matches found\b/i.test(text)) {
		return new BlockTextView(
			renderStatusLine(theme, {
				title: "Search:",
				description: pattern,
				meta: ["no matches", `in ${shortenDisplayPath(noMatchPath)}`],
			}),
			theme,
			shouldRender,
			() => "",
			null,
		);
	}
	if (!text.startsWith("[")) {
		return framedBlock(theme, {
			header: renderStatusHeader(
				"Search:",
				theme,
				` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${text} · in ${shortenDisplayPath(noMatchPath)}`)}`,
			),
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: shouldRender,
		});
	}
	const sections = parseHashlineSections(text);
	const matchCount = sections.reduce(
		(count, section) => count + section.rows.filter((row) => row.startsWith("*")).length,
		0,
	);
	const fileText = `${sections.length} file${sections.length === 1 ? "" : "s"}`;
	const path = typeof args?.path === "string" ? splitReadPathSelector(args.path).path : sections[0]?.path;
	const header = renderStatusHeader(
		"Search:",
		theme,
		` ${theme.fg("warning", pattern)} ${theme.fg("dim", `${matchCount} match${matchCount === 1 ? "" : "es"} · ${fileText} · in ${shortenDisplayPath(path ?? ".")} · `)}${tokenCostLabel(theme, text, "search")}`,
	);
	return framedBlock(theme, {
		header,
		sections: [
			{
				component: new BlockTextView(
					renderSearchSections(sections, theme, options.expanded ?? false, pattern, context?.cwd ?? process.cwd()),
					theme,
					() => true,
					() => (options.expanded ? "expanded" : ""),
					null,
				),
			},
		],
		borderColor: "borderMuted",
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: shouldRender,
	});
}

function findRequestTarget(args: { paths?: string[]; pattern?: unknown; path?: unknown }): string {
	if (Array.isArray(args.paths) && args.paths.length > 0) return args.paths.join(", ");
	if (typeof args.pattern === "string") return args.pattern;
	if (typeof args.path === "string") return args.path;
	return ".";
}

function findRequestWhere(args: { paths?: string[]; path?: unknown }): string {
	const first = args.paths?.[0];
	if (first) return isResourceUri(first) ? first : dirname(first);
	return typeof args.path === "string" ? args.path : ".";
}

function renderFindCall(
	params: { paths?: string[]; pattern?: unknown; path?: unknown },
	theme: RenderTheme,
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
): Component {
	if (context?.isPartial !== true) return EMPTY_VIEW;
	const target = findRequestTarget(params);
	if (isResourceUri(target)) return renderResourceLoading("find", target, theme, context) ?? EMPTY_VIEW;
	return framedBlock(theme, {
		header: renderStatusHeader(
			"Find:",
			theme,
			` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `in ${shortenDisplayPath(findRequestWhere(params))}`)}`,
			"pending",
		),
		sections: [{ lines: [theme.fg("muted", "Finding files...")] }],
		borderColor: "borderMuted",
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: () => context?.isPartial === true,
	});
}

function renderFindResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	args?: { paths?: string[]; pattern?: unknown; path?: unknown },
	context?: Partial<ToolRenderContext<Record<string, unknown>, unknown>>,
	latestTurnToolCallIds: ReadonlySet<string> = EMPTY_TOOL_CALL_IDS,
	getLatestTurnIndex: () => number | undefined = () => undefined,
): Component {
	const request = args ?? {};
	if (options.isPartial) return renderFindCall(request, theme, context);
	const shouldRender = () =>
		shouldRenderLatestToolResult(result, context, latestTurnToolCallIds, getLatestTurnIndex());
	if (!shouldRender()) return EMPTY_VIEW;
	const resources = resourceDetailsList(result, "resources");
	if (resources.length > 0) {
		const resourceCard = renderResourceListCard(
			resources,
			"find",
			`scope: ${shortenDisplayPath(findRequestWhere(request))}`,
			theme,
			shouldRender,
		);
		if (resourceCard) return resourceCard;
	}
	const output = firstTextContent(result).trim();
	if (/not found on PATH|failed|error/i.test(output.split("\n")[0] ?? "")) {
		return framedBlock(theme, {
			header: renderStatusHeader("Find:", theme, "", "error"),
			sections: [{ lines: [theme.fg("error", output)] }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
			visible: shouldRender,
		});
	}
	const outputLines = toolTextLines(output).filter(Boolean);
	const noResults = /^No (?:files|resources) found\b/i.test(output);
	const diagnostics = outputLines.filter((line) => /^(?:Showing \w+ \d|\[output bounded\b)/.test(line));
	const files = noResults ? [] : outputLines.filter((line) => !diagnostics.includes(line));
	const target = findRequestTarget(request);
	const where = findRequestWhere(request);
	// One line, no card. Keyed off the real no-match text, never off empty output: rgFailure throws before this, so a
	// failure can no longer arrive here disguised as absence.
	if (noResults && diagnostics.length === 0) {
		return new BlockTextView(
			renderStatusLine(theme, {
				title: "Find:",
				description: shortenDisplayPath(target),
				meta: ["no files", `in ${shortenDisplayPath(where)}`],
			}),
			theme,
			shouldRender,
			() => "",
			null,
		);
	}
	const header = renderStatusHeader(
		"Find:",
		theme,
		` ${theme.fg("warning", shortenDisplayPath(target))} ${theme.fg("dim", `${files.length} file${files.length === 1 ? "" : "s"} · in ${shortenDisplayPath(where)} · `)}${tokenCostLabel(theme, output, "find")}`,
	);
	const shown = files.slice(0, options.expanded ? files.length : 20);
	const lines =
		shown.length > 0
			? shown.map((file, index) => {
					const linkedPath = renderExplorationSummaryPart(
						{
							text: shortenDisplayPath(file),
							role: "mdLink",
							url: pathToFileURL(resolve(context?.cwd ?? process.cwd(), file)).href,
						},
						theme,
					);
					return `${theme.fg("dim", `${index === shown.length - 1 ? treeLast(theme) : treeBranch(theme)} ${fileIcon(theme, file)} `)}${linkedPath}`;
				})
			: [theme.fg("muted", output || "No files found")];
	if (files.length > shown.length) {
		lines.push(
			`${theme.fg("muted", `... (${files.length - shown.length} more files, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
		);
	}
	for (const diagnostic of diagnostics) lines.push(theme.fg("muted", diagnostic));
	return framedBlock(theme, {
		header,
		sections: [{ lines }],
		borderColor: "borderMuted",
		backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
		visible: shouldRender,
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
	});
}
function renderWriteCard(
	params: { path?: string; content?: string },
	theme: RenderTheme,
	options: {
		expanded?: boolean;
		state: "pending" | "success" | "error";
		error?: string;
		context?: StreamingRenderContext;
	},
): Component {
	const path = params.path ? shortenDisplayPath(params.path) : invalidArgText(theme);
	const rest = ` ${fileIcon(theme, params.path)} ${theme.fg("accent", path)}`;
	if (typeof params.content !== "string") {
		return framedBlock(theme, {
			header: renderStatusHeader("Write", theme, rest, "error"),
			sections: [{ lines: [theme.fg("error", options.error ?? "[invalid content arg - expected string]")] }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
		});
	}
	const rawRows = params.content.split("\n");
	const numberedRows = rawRows.map((line, index) => `${index + 1}:${line}`);
	const pending = options.state === "pending";
	const start = pending && !options.expanded ? Math.max(0, rawRows.length - 12) : 0;
	const end = options.expanded ? rawRows.length : pending ? rawRows.length : Math.min(rawRows.length, 12);
	const visibleRows = rawRows.slice(start, end);
	const highlightedRows = highlightCodeRowsSync(params.path, visibleRows);
	const lines = renderNumberedRows(numberedRows.slice(start, end), theme, visibleRows.length, highlightedRows).split(
		"\n",
	);
	if (start > 0) lines.unshift(theme.fg("dim", `… (${start} earlier line${start === 1 ? "" : "s"})`));
	if (!pending && end < rawRows.length) {
		lines.push(
			theme.fg("muted", `... (${rawRows.length - end} more lines, `) +
				keyHint("app.tools.expand", "to expand") +
				theme.fg("muted", ")"),
		);
	}
	if (pending) lines.push(streamingStatusLine(theme, options.context, "streaming"));
	if (options.error) lines.push(theme.fg("error", options.error));
	return framedBlock(theme, {
		header: renderStatusHeader(
			"Write",
			theme,
			`${rest} ${theme.fg("dim", `· ${rawRows.length} lines`)}`,
			options.state === "error" ? "error" : pending ? "pending" : "success",
		),
		sections: [{ lines }],
		borderColor: options.state === "error" ? "error" : "borderMuted",
		backgroundAnsi:
			options.state === "error"
				? cardBackgroundAnsi(theme, "toolErrorBg")
				: cardBackgroundAnsi(theme, "toolPendingBg"),
	});
}

function renderWriteCall(
	params: { path?: string; content?: string },
	theme: RenderTheme,
	context: StreamingRenderContext = {},
): Component {
	const running = context.isPartial === true;
	scheduleStreamingInvalidation(context, running);
	return running
		? renderWriteCard(params, theme, { expanded: context.expanded, state: "pending", context })
		: EMPTY_VIEW;
}

function renderWriteResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	context?: StreamingRenderContext & { args?: { path?: string; content?: string }; isError?: boolean },
): Component {
	if (options.isPartial) return EMPTY_VIEW;
	const text = firstTextContent(result);
	const error = context?.isError || /error/i.test(text) ? text : undefined;
	return renderWriteCard(context?.args ?? {}, theme, {
		expanded: options.expanded,
		state: error ? "error" : "success",
		error,
	});
}

type EditSummary = { target?: string; display?: string; line?: number; suffix: string };

function shortenHashlineHeader(header: string): string {
	const match = /^\[([^#\]]+)(#[0-9A-Fa-f]{4})?\]$/.exec(header);
	if (!match) return shortenDisplayPath(header);
	return `[${shortenDisplayPath(match[1] ?? "")}${match[2] ?? ""}]`;
}

function summarizeEditInput(input: unknown, mode: EditMode): EditSummary {
	if (typeof input !== "string") return { suffix: ` (${mode})` };
	const hashline = input.match(/^(\[([^#\n\]]+)(?:#[0-9A-Fa-f]{4})?\])$/m);
	const range = input.match(/^(?:replace|delete|insert)\s+(?:block\s+|before\s+|after\s+)?([1-9]\d*)/m);
	if (hashline) {
		return {
			target: hashline[2],
			display: shortenHashlineHeader(hashline[1] ?? ""),
			line: range ? Number(range[1]) : undefined,
			suffix: "",
		};
	}
	const file = input.match(/^\*\*\* (?:File|Add File|Update File|Delete File):\s*(.+)$/m);
	if (file) return { target: file[1], suffix: "" };
	return { suffix: ` (${mode})` };
}

function renderEditHeaderDisplay(
	target: string,
	display: string | undefined,
	line: number | undefined,
	theme: RenderTheme,
) {
	const lineSuffix = line ? theme.fg("warning", `:${line}`) : "";
	const renderedTarget = display?.startsWith("[")
		? renderHashlineHeader(display, theme)
		: theme.fg("accent", display ?? shortenDisplayPath(target));
	return `${fileIcon(theme, target)} ${renderedTarget}${lineSuffix}`;
}

function renderEditStreamingRows(lines: readonly string[], summary: EditSummary, theme: RenderTheme): string[] {
	const codeRows = lines.map((line) => (/^[+-](?![+-]{2})/.test(line) ? line.slice(1) : ""));
	const highlighted = highlightCodeRowsSync(summary.target, codeRows);
	return lines.map((line, index) => {
		if (/^\[.+(?:#[0-9A-Fa-f]{0,4})?\]?$/.test(line)) return renderHashlineHeader(line, theme);
		if (/^\*\*\* (?:Begin|End|Add|Update|Delete|Move)/.test(line)) return theme.fg("syntaxKeyword", line);
		if (/^(?:replace|delete|insert|create|update)\b/.test(line)) {
			const [verb = "", ...rest] = line.split(" ");
			return `${theme.fg("syntaxKeyword", verb)}${rest.length ? ` ${theme.fg("toolOutput", rest.join(" "))}` : ""}`;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			return `${theme.fg("toolDiffAdded", "+")}${highlighted[index] ?? theme.fg("toolOutput", line.slice(1))}`;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			return `${theme.fg("toolDiffRemoved", "-")}${highlighted[index] ?? theme.fg("toolOutput", line.slice(1))}`;
		}
		return theme.fg("toolOutput", line);
	});
}

function renderEditCall(
	summary: EditSummary,
	input: unknown,
	config: EditConfig,
	theme: RenderTheme,
	context: StreamingRenderContext & { cwd?: string; argsComplete?: boolean } = {},
): Component {
	const running = context.isPartial === true;
	scheduleStreamingInvalidation(context, running);
	if (!running) return EMPTY_VIEW;
	const rest = summary.target
		? ` ${renderEditHeaderDisplay(summary.target, summary.display, summary.line, theme)}${theme.fg("dim", summary.suffix)}`
		: ` ${invalidArgText(theme)}${theme.fg("dim", summary.suffix)}`;
	const backgroundAnsi = cardBackgroundAnsi(theme, "toolPendingBg");
	const preview = editPreviewForInput(
		input,
		config,
		context.cwd ?? resolve("."),
		context.state,
		context.argsComplete === true,
	);
	if (preview) {
		const renderHeader: DiffSectionHeaderRenderer = (target, line, theme) =>
			renderStatusHeader(
				"Edit:",
				theme,
				` ${renderEditHeaderDisplay(
					target,
					preview.headers.has(target) ? shortenHashlineHeader(preview.headers.get(target) ?? "") : undefined,
					line,
					theme,
				)}`,
				"pending",
			);
		return framedBlock(theme, {
			header: renderStatusHeader("Edit", theme, rest, "pending"),
			sections: [
				{
					component: new EditDiffView(
						preview.diff,
						undefined,
						context.expanded === true,
						theme,
						backgroundAnsi,
						renderHeader,
					),
				},
				{ lines: [streamingStatusLine(theme, context, "streaming")] },
			],
			borderColor: "borderMuted",
			backgroundAnsi,
		});
	}
	const allLines = typeof input === "string" ? input.replace(/\t/g, "  ").split(/\r?\n/) : [];
	if (allLines.at(-1) === "") allLines.pop();
	const visible = context.expanded ? allLines : allLines.slice(-12);
	const hidden = allLines.length - visible.length;
	const lines = renderEditStreamingRows(visible, summary, theme);
	if (hidden > 0) lines.unshift(theme.fg("dim", `… (${hidden} earlier line${hidden === 1 ? "" : "s"})`));
	lines.push(streamingStatusLine(theme, context, "streaming"));
	return framedBlock(theme, {
		header: renderStatusHeader("Edit", theme, rest, "pending"),
		sections: [{ lines }],
		borderColor: "borderMuted",
		backgroundAnsi,
	});
}
function renderEditResult(
	result: ToolTextResult,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: RenderTheme,
	context: Partial<ToolRenderContext<Record<string, unknown>, EditInput>> | undefined,
	latestTurnEditToolCallIds: ReadonlySet<string>,
	getLatestTurnIndex: () => number | undefined,
	mode: EditMode,
) {
	if (options.isPartial) return EMPTY_VIEW;
	const text = firstTextContent(result);
	const firstLine = text.split("\n")[0] ?? "";
	const summary = summarizeEditInput(context?.args?.input, mode);
	const rest = summary.target
		? ` ${renderEditHeaderDisplay(summary.target, summary.display, summary.line, theme)}${theme.fg("dim", summary.suffix)}`
		: ` ${theme.fg("dim", summary.suffix)}`;
	const isLatestTurnEdit = () =>
		shouldRenderLatestToolResult(result, context, latestTurnEditToolCallIds, getLatestTurnIndex());
	if (!firstLine.startsWith("[") && /rejected|error/i.test(firstLine)) {
		return framedBlock(theme, {
			header: renderStatusHeader("Edit:", theme, rest, "error"),
			sections: [{ lines: text.split("\n").map((line) => theme.fg("error", line)) }],
			borderColor: "error",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolErrorBg"),
			visible: isLatestTurnEdit,
		});
	}
	const diff =
		typeof result.details?.diff === "string"
			? result.details.diff
			: typeof result.details?.patch === "string"
				? result.details.patch
				: "";
	if (!diff) {
		return framedBlock(theme, {
			header: renderStatusHeader("Edit:", theme, rest),
			sections: [
				{ lines: (options.expanded ? text : firstLine).split("\n").map((line) => theme.fg("toolOutput", line)) },
			],
			borderColor: "borderMuted",
			backgroundAnsi: cardBackgroundAnsi(theme, "toolPendingBg"),
			visible: isLatestTurnEdit,
		});
	}
	const rows = Array.isArray(result.details?.highlightedDiffRows)
		? (result.details.highlightedDiffRows as DiffRenderRow[])
		: undefined;
	const resultHeaders = new Map<string, string>();
	if (Array.isArray(result.details?.results)) {
		for (const section of result.details.results as Array<{ path?: unknown; header?: unknown }>) {
			if (typeof section.path === "string" && typeof section.header === "string") {
				resultHeaders.set(section.path, shortenHashlineHeader(section.header));
			}
		}
	}
	const backgroundAnsi = cardBackgroundAnsi(theme, "toolPendingBg");
	const renderHashlineEditSectionHeader: DiffSectionHeaderRenderer = (target, line, theme) =>
		renderStatusHeader("Edit:", theme, ` ${renderEditHeaderDisplay(target, resultHeaders.get(target), line, theme)}`);
	return framedBlock(theme, {
		header: renderStatusHeader("Edit:", theme, rest),
		sections: [
			{
				component: new EditDiffView(
					diff,
					rows,
					options.expanded === true,
					theme,
					backgroundAnsi,
					renderHashlineEditSectionHeader,
				),
			},
		],
		borderColor: "borderMuted",
		backgroundAnsi,
		cacheKey: () => (options.expanded ? "expanded" : "collapsed"),
		visible: isLatestTurnEdit,
	});
}

function editResultTurnIndex(result: ToolTextResult): number | undefined {
	const value = result.details?.editTurnIndex;
	return typeof value === "number" ? value : undefined;
}

/** A fileops tool whose card only draws while its call is inside the visible window. */
function isGatedFileopsTool(toolName: unknown): boolean {
	return toolName === "edit" || toolName === "search" || toolName === "find";
}

/**
 * The ids of gated fileops calls a code cell made, read back off the cell's result.
 *
 * pi never dispatched a nested call, so it is not a `toolCall` block on an assistant
 * message. Rebuilding the window from assistant blocks alone dropped every card a cell
 * drew, on the next compaction or resume. code-mode records each call under the id its
 * execution ran on, which is the id the card is keyed on.
 */
function nestedFileopsCallIds(message: { details?: unknown }): string[] {
	const calls = (message.details as { calls?: unknown } | undefined)?.calls;
	if (!Array.isArray(calls)) return [];
	const ids: string[] = [];
	for (const entry of calls) {
		const call = entry as { name?: unknown; toolCallId?: unknown } | undefined;
		if (!isGatedFileopsTool(call?.name)) continue;
		if (typeof call?.toolCallId === "string" && call.toolCallId.length > 0) ids.push(call.toolCallId);
	}
	return ids;
}

function shouldRenderLatestToolResult(
	result: ToolTextResult,
	context: Partial<ToolRenderContext<Record<string, unknown>, unknown>> | undefined,
	latestTurnToolCallIds: ReadonlySet<string>,
	latestTurnIndex: number | undefined,
): boolean {
	if (context?.executionStarted === false) {
		return typeof context.toolCallId === "string" && latestTurnToolCallIds.has(context.toolCallId);
	}
	if (context === undefined || context.executionStarted === undefined) return true;
	if (typeof context.toolCallId === "string" && latestTurnToolCallIds.has(context.toolCallId)) return true;
	if (latestTurnIndex === undefined) return context.executionStarted === true;
	const turnIndex = editResultTurnIndex(result);
	return turnIndex !== undefined && turnIndex === latestTurnIndex;
}
export type FileopsRenderTracking = {
	latestTurnToolCallIds: ReadonlySet<string>;
	getLatestTurnIndex: () => number | undefined;
};

export function createFileopsPresentation(
	getConfig: () => EditConfig,
	renderTracking: FileopsRenderTracking,
): (definition: RegisteredToolDefinition) => RegisteredToolDefinition {
	const ast = createAstToolPresentation();
	return (definition) => {
		const base = definition as RegisteredToolDefinition & ToolPresentationDefinition;
		switch (definition.name) {
			case "read":
				return {
					...base,
					renderShell: "self",
					renderCall: (params: unknown, theme: RenderTheme, context: unknown) =>
						renderReadCall(params as { path?: string }, theme, context as any),
					renderResult: (result: ToolTextResult, options: unknown, theme: RenderTheme, context: any) =>
						renderReadResult(
							result,
							{ ...(options as object), isError: context?.isError === true },
							theme,
							context?.toolCallId,
							context?.invalidate,
							context?.lastComponent,
						),
				};
			case "search":
				return {
					...base,
					renderShell: "self",
					rendersOwnFailure: true,
					renderCall: (params: unknown, theme: RenderTheme, context: unknown) =>
						renderSearchCall(params as { pattern?: unknown; path?: unknown }, theme, context as any),
					renderResult: (result: ToolTextResult, options: unknown, theme: RenderTheme, context: any) =>
						renderSearchResult(
							result,
							options as any,
							theme,
							context?.args,
							context,
							renderTracking.latestTurnToolCallIds,
							renderTracking.getLatestTurnIndex,
						),
				};
			case "find":
				return {
					...base,
					renderShell: "self",
					renderCall: (params: unknown, theme: RenderTheme, context: unknown) =>
						renderFindCall(
							params as { paths?: string[]; pattern?: unknown; path?: unknown },
							theme,
							context as any,
						),
					renderResult: (result: ToolTextResult, options: unknown, theme: RenderTheme, context: any) =>
						renderFindResult(
							result,
							options as any,
							theme,
							context?.args,
							context,
							renderTracking.latestTurnToolCallIds,
							renderTracking.getLatestTurnIndex,
						),
				};
			case "write":
				return {
					...base,
					renderShell: "self",
					renderCall: (params: unknown, theme: RenderTheme, context: unknown) =>
						renderWriteCall(params as { path?: string; content?: string }, theme, context as any),
					renderResult: (result: ToolTextResult, options: unknown, theme: RenderTheme, context: unknown) =>
						renderWriteResult(result, options as any, theme, context as any),
				};
			case "edit":
				return {
					...base,
					renderShell: "self",
					renderCall: (params: unknown, theme: RenderTheme, context: unknown) => {
						const input = (params as { input?: unknown }).input;
						const config = getConfig();
						return renderEditCall(summarizeEditInput(input, config.mode), input, config, theme, context as any);
					},
					renderResult: (result: ToolTextResult, options: unknown, theme: RenderTheme, context: unknown) => {
						const config = getConfig();
						return renderEditResult(
							result,
							options as any,
							theme,
							context as any,
							renderTracking.latestTurnToolCallIds,
							renderTracking.getLatestTurnIndex,
							config.mode,
						);
					},
				};
			case "ast_grep":
				return {
					...base,
					renderShell: ast.renderShell,
					renderCall: ast.astGrepCall,
					renderResult: ast.astGrepResult,
				};
			case "ast_edit":
				return {
					...base,
					renderShell: ast.renderShell,
					renderCall: ast.astEditCall,
					renderResult: ast.astEditResult,
				};
			default:
				return definition;
		}
	};
}

export {
	isGatedFileopsTool,
	nestedFileopsCallIds,
	renderEditCall,
	renderEditResult,
	renderFindCall,
	renderFindResult,
	renderReadCall,
	renderReadResult,
	renderSearchCall,
	renderSearchResult,
	renderWriteCall,
	renderWriteResult,
	shouldRenderLatestToolResult,
	summarizeEditInput,
};
