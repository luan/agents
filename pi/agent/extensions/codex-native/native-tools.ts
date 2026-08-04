import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, getImageDimensions, Spacer, type Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readPreviewImageFromPathSync } from "../shared/image-preview";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";
import { registerExtensionMessageRenderer, textComponent } from "../shared/tui";

export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";
const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const IMAGE_GENERATION_TOOL_NAME = "image_generation";

const OPENAI_CODEX_IMAGE_DIR = ".pi/openai-codex-images";
const OPENAI_CODEX_LATEST_IMAGE_NAME = "latest.png";

type FunctionToolPayload = {
	type?: unknown;
	name?: unknown;
};

type ResponsesPayload = {
	tools?: unknown[];
	[key: string]: unknown;
};

export type SavedGeneratedImage = {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId: string | undefined;
	callId: string;
	outputFormat: string;
	mimeType: string;
	width?: number;
	height?: number;
	sha256: string;
	revisedPrompt?: string;
};

type GeneratedImageArtifact = {
	id: string;
	path: string;
	mime_type: string;
	width?: number;
	height?: number;
	sha256: string;
};

export type SurfacedWebSearch = {
	callId: string;
	status?: string;
	query?: string;
	queries: string[];
	sources: Array<{ title?: string; url: string }>;
};

type ImageDisplayMessageDetails = {
	savedImages: SavedGeneratedImage[];
};

type ImageGenerationCallItem = {
	type: "image_generation_call";
	id: string;
	status?: string;
	result: string | null;
	output_format?: string;
	revised_prompt?: string;
};

type GeneratedImageForDisplay = {
	callId: string;
	result: string;
	outputFormat?: string;
	revisedPrompt?: string;
	responseId?: string;
};

const displayedGeneratedImageKeys = new Set<string>();
const registeredRendererApis = new WeakSet<ExtensionAPI>();

function generatedImageKey(responseId: string | undefined, callId: string): string {
	return `${responseId ?? ""}:${callId}`;
}

export function markGeneratedImageDisplayed(responseId: string | undefined, callId: string): void {
	displayedGeneratedImageKeys.add(generatedImageKey(responseId, callId));
}

function wasGeneratedImageDisplayed(responseId: string | undefined, callId: string): boolean {
	return displayedGeneratedImageKeys.has(generatedImageKey(responseId, callId));
}

function isOpenAICodexModel(model: ExtensionContext["model"]): boolean {
	return (model?.provider ?? "").toLowerCase() === "openai-codex";
}

function supportsImageInputs(model: ExtensionContext["model"]): boolean {
	return Array.isArray(model?.input) && model.input.includes("image");
}

export function supportsNativeWebSearch(model: ExtensionContext["model"]): boolean {
	return isOpenAICodexModel(model);
}

export function supportsNativeImageGeneration(model: ExtensionContext["model"]): boolean {
	return isOpenAICodexModel(model) && supportsImageInputs(model);
}

function isFunctionToolNamed(tool: unknown, name: string): tool is FunctionToolPayload {
	return (
		!!tool &&
		typeof tool === "object" &&
		(tool as FunctionToolPayload).type === "function" &&
		(tool as FunctionToolPayload).name === name
	);
}

export function rewriteNativeWebSearchTool(payload: unknown, model: ExtensionContext["model"]): unknown {
	if (!supportsNativeWebSearch(model) || !payload || typeof payload !== "object") return payload;
	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) return payload;

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isFunctionToolNamed(tool, "web_search")) return tool;
		rewritten = true;
		return {
			type: "web_search",
			external_web_access: true,
			search_content_types: ["text", "image"],
		};
	});

	return rewritten ? { ...(payload as ResponsesPayload), tools: nextTools } : payload;
}

export function rewriteNativeImageGenerationTool(payload: unknown, model: ExtensionContext["model"]): unknown {
	if (!supportsNativeImageGeneration(model) || !payload || typeof payload !== "object") return payload;
	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) return payload;

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isFunctionToolNamed(tool, IMAGE_GENERATION_TOOL_NAME)) return tool;
		rewritten = true;
		return {
			type: "image_generation",
			output_format: "png",
		};
	});

	return rewritten ? { ...(payload as ResponsesPayload), tools: nextTools } : payload;
}

function normalizeImageOutputFormat(value: string | undefined): string {
	const format = (value ?? "png").toLowerCase();
	return format === "png" || format === "jpg" || format === "jpeg" || format === "webp" ? format : "png";
}

function sanitizeFilePart(value: string | undefined, fallback: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return fallback;
	return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shortenFilePart(value: string | undefined, fallback: string): string {
	const safe = sanitizeFilePart(value, fallback);
	if (safe.length <= 16) return safe;
	return `${safe.slice(0, 10)}-${safe.slice(-5)}`;
}

async function pathExists(value: string): Promise<boolean> {
	try {
		await fsPromises.access(value);
		return true;
	} catch {
		return false;
	}
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		if (await pathExists(resolve(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function displayRelative(root: string, filePath: string): string {
	const relativePath = relative(root, filePath);
	return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : filePath;
}

function getOpenAICodexImageDirectory(cwd: string): string {
	return resolve(cwd, OPENAI_CODEX_IMAGE_DIR);
}

function getOpenAICodexImagePath(
	cwd: string,
	responseId: string | undefined,
	callId: string,
	outputFormat?: string,
): string {
	const ext = normalizeImageOutputFormat(outputFormat);
	return resolve(
		getOpenAICodexImageDirectory(cwd),
		`${shortenFilePart(callId, "image")}-${shortenFilePart(responseId, "response")}.${ext}`,
	);
}

export function getOpenAICodexLatestImagePath(cwd: string): string {
	return resolve(getOpenAICodexImageDirectory(cwd), OPENAI_CODEX_LATEST_IMAGE_NAME);
}

export async function saveOpenAICodexGeneratedImage(
	cwd: string,
	image: {
		responseId?: string;
		callId: string;
		result: string;
		outputFormat?: string;
		revisedPrompt?: string;
	},
): Promise<SavedGeneratedImage> {
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const outputFormat = normalizeImageOutputFormat(image.outputFormat);
	const mimeType = outputFormat === "jpg" || outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
	const absolutePath = getOpenAICodexImagePath(workspaceRoot, image.responseId, image.callId, outputFormat);
	const latestAbsolutePath = getOpenAICodexLatestImagePath(workspaceRoot);
	const bytes = Buffer.from(image.result, "base64");
	const dimensions = getImageDimensions(image.result, mimeType);
	await fsPromises.mkdir(dirname(absolutePath), { recursive: true });
	await fsPromises.writeFile(absolutePath, bytes);
	await fsPromises.writeFile(latestAbsolutePath, bytes);

	return {
		absolutePath,
		relativePath: displayRelative(workspaceRoot, absolutePath),
		latestAbsolutePath,
		latestRelativePath: displayRelative(workspaceRoot, latestAbsolutePath),
		responseId: image.responseId,
		callId: image.callId,
		outputFormat,
		mimeType,
		...(dimensions ? { width: dimensions.widthPx, height: dimensions.heightPx } : {}),
		sha256: createHash("sha256").update(bytes).digest("hex"),
		revisedPrompt: image.revisedPrompt,
	};
}

function generatedImageArtifact(image: SavedGeneratedImage): GeneratedImageArtifact {
	return {
		id: image.callId,
		path: image.absolutePath,
		mime_type: image.mimeType,
		...(image.width === undefined ? {} : { width: image.width }),
		...(image.height === undefined ? {} : { height: image.height }),
		sha256: image.sha256,
	};
}

export function buildGeneratedImageArtifactResult(savedImages: SavedGeneratedImage[]): string {
	return JSON.stringify({ artifacts: savedImages.map(generatedImageArtifact) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function sanitizeImageGenerationCallItem(item: unknown): ImageGenerationCallItem | undefined {
	if (!isRecord(item)) return undefined;
	if (item.type !== "image_generation_call") return undefined;
	if (typeof item.id !== "string" || item.id.length === 0) return undefined;
	if (!(typeof item.result === "string" || item.result === null)) return undefined;
	return {
		type: "image_generation_call",
		id: item.id,
		...(typeof item.status === "string" ? { status: item.status } : {}),
		result: item.result,
		...(typeof item.output_format === "string" ? { output_format: item.output_format } : {}),
		...(typeof item.revised_prompt === "string" ? { revised_prompt: item.revised_prompt } : {}),
	};
}

function extractGeneratedImageCalls(message: unknown): GeneratedImageForDisplay[] {
	if (!isRecord(message) || !Array.isArray(message.content)) return [];
	const responseId = typeof message.responseId === "string" ? message.responseId : undefined;
	const images: GeneratedImageForDisplay[] = [];
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "image_generation_call") continue;
		const item = sanitizeImageGenerationCallItem(block.item);
		if (!item?.result) continue;
		images.push({
			callId: item.id,
			result: item.result,
			responseId,
			...(item.output_format ? { outputFormat: item.output_format } : {}),
			...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
		});
	}
	return images;
}

export async function saveGeneratedImagesFromAssistantMessage(
	cwd: string,
	message: unknown,
): Promise<SavedGeneratedImage[]> {
	const savedImages: SavedGeneratedImage[] = [];
	for (const image of extractGeneratedImageCalls(message)) {
		if (wasGeneratedImageDisplayed(image.responseId, image.callId)) continue;
		try {
			const savedImage = await saveOpenAICodexGeneratedImage(cwd, {
				responseId: image.responseId,
				callId: image.callId,
				result: image.result,
				outputFormat: image.outputFormat,
				revisedPrompt: image.revisedPrompt,
			});
			markGeneratedImageDisplayed(image.responseId, image.callId);
			savedImages.push(savedImage);
		} catch {
			// Rendering generated images is best-effort; the assistant message should still complete normally.
		}
	}
	return savedImages;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function extractWebSearch(item: unknown): SurfacedWebSearch | undefined {
	if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") return undefined;
	const record = item as Record<string, unknown>;
	const callId =
		typeof record.id === "string" ? record.id : typeof record.call_id === "string" ? record.call_id : undefined;
	if (!callId) return undefined;

	const action =
		typeof record.action === "object" && record.action !== null ? (record.action as Record<string, unknown>) : {};
	const query =
		typeof action.query === "string" ? action.query : typeof record.query === "string" ? record.query : undefined;
	const queries = [...stringArray(action.queries), ...stringArray(record.queries)];
	if (query && !queries.includes(query)) queries.unshift(query);

	const sources: Array<{ title?: string; url: string }> = [];
	const seen = new Set<string>();
	const addSource = (source: unknown) => {
		if (!source || typeof source !== "object") return;
		const sourceRecord = source as Record<string, unknown>;
		const url = typeof sourceRecord.url === "string" ? sourceRecord.url : undefined;
		if (!url || seen.has(url)) return;
		seen.add(url);
		sources.push({
			url,
			...(typeof sourceRecord.title === "string" ? { title: sourceRecord.title } : {}),
		});
	};

	for (const source of Array.isArray(action.sources) ? action.sources : []) addSource(source);
	for (const source of Array.isArray(record.results) ? record.results : []) addSource(source);

	return {
		callId,
		status: typeof record.status === "string" ? record.status : undefined,
		query,
		queries,
		sources,
	};
}

export function buildWebSearchActivityMessage(searches: SurfacedWebSearch[]): string {
	return searches
		.map((search, index) => {
			const lines = [searches.length > 1 ? `Web search results ${index + 1}` : "Web search results"];
			if (search.queries.length > 0) {
				lines.push("Queries:");
				for (const query of search.queries) lines.push(`- ${query}`);
			}
			if (search.sources.length > 0) {
				lines.push("Sources:");
				for (const source of search.sources.slice(0, 5))
					lines.push(`- ${source.title ? `${source.title} — ` : ""}${source.url}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function webSearchQueryText(search: SurfacedWebSearch): string {
	return search.queries.length > 0 ? search.queries.join(", ") : (search.query ?? "web");
}

function webSearchSources(searches: SurfacedWebSearch[]): Array<{ title?: string; url: string }> {
	const seen = new Set<string>();
	const sources: Array<{ title?: string; url: string }> = [];
	for (const search of searches) {
		for (const source of search.sources) {
			if (seen.has(source.url)) continue;
			seen.add(source.url);
			sources.push(source);
		}
	}
	return sources;
}

function webSearchSourceLabel(source: { title?: string; url: string }): string {
	const title = source.title?.trim();
	if (title) return title;
	try {
		return new URL(source.url).hostname.replace(/^www\./, "");
	} catch {
		return source.url;
	}
}

function shortenWebSearchSourceLabel(label: string): string {
	return label.length <= 48 ? label : `${label.slice(0, 45)}...`;
}

function renderWebSearchResultSummary(searches: SurfacedWebSearch[], theme: any): string | undefined {
	const sources = webSearchSources(searches);
	if (sources.length === 0) return undefined;
	const countLabel = sources.length === 1 ? "1 result" : `${sources.length} results`;
	const visibleLabels = sources.slice(0, 5).map((source) => shortenWebSearchSourceLabel(webSearchSourceLabel(source)));
	const hiddenCount = sources.length - visibleLabels.length;
	const labelsText = hiddenCount > 0 ? `${visibleLabels.join(", ")}, +${hiddenCount} more` : visibleLabels.join(", ");
	return `${theme.fg("accent", `${countLabel}:`)} ${theme.fg("muted", labelsText)}`;
}

function renderWebSearchActivity(searches: SurfacedWebSearch[], theme: any): string {
	const marker = theme.fg("success", "•");
	const effectiveSearches = searches.length > 0 ? searches : [{ callId: "", queries: [], sources: [] }];
	const queryText = effectiveSearches.map(webSearchQueryText).join("; ");
	const resultSummary = renderWebSearchResultSummary(searches, theme);
	let text = `${marker} ${theme.bold("Web Searched")} ${theme.fg("muted", queryText)}`;
	if (resultSummary) text += `${theme.fg("dim", " · ")}${resultSummary}`;
	return text;
}

export function createImageGenerationTool(): ToolDefinition<any> {
	return {
		name: IMAGE_GENERATION_TOOL_NAME,
		label: IMAGE_GENERATION_TOOL_NAME,
		renderShell: "self",
		description:
			"Generate an image with native OpenAI Codex image_generation. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `latest.png`.",
		promptSnippet:
			"Generate an image with native OpenAI Codex image_generation. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `latest.png`.",
		parameters: Type.Unsafe<Record<string, never>>({
			type: "object",
			properties: {},
			additionalProperties: false,
		}),
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) {
				throw new Error("image_generation is only available with openai-codex gpt-5.5");
			}
			throw new Error("image_generation is a native openai-codex provider tool and should not execute locally");
		},
		renderCall(_args, theme, context) {
			const text = (context?.lastComponent as Text | undefined) ?? textComponent("");
			const running = context?.isPartial !== false;
			const marker = theme.fg(running ? "dim" : "success", "•");
			text.setText(`${marker} ${theme.bold(running ? "Generating image" : "Generated image")}`);
			return text;
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Container();
			const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
			return textComponent(theme.fg("dim", text));
		},
	};
}

export function createWebSearchTool(): ToolDefinition<any> {
	return {
		name: WEB_SEARCH_TOOL_NAME,
		label: WEB_SEARCH_TOOL_NAME,
		description:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		promptSnippet:
			"Search the web for sources relevant to the current task. Use it when you need up-to-date information, external references, or broader context beyond the workspace.",
		parameters: Type.Unsafe<Record<string, never>>({
			type: "object",
			additionalProperties: false,
		}),
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeWebSearch(ctx.model)) {
				throw new Error("web_search is only available with openai-codex models");
			}
			throw new Error("web_search is a native openai-codex provider tool and should not execute locally");
		},
		renderCall(_args, theme) {
			return textComponent(theme.fg("toolTitle", theme.bold(WEB_SEARCH_TOOL_NAME)));
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Container();
			const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
			return textComponent(theme.fg("dim", text));
		},
	};
}

function shortenPrompt(prompt: string, max = 96): string {
	const singleLine = prompt.replace(/\s+/g, " ").trim();
	if (singleLine.length <= max) return singleLine;
	return `${singleLine.slice(0, max - 3)}...`;
}

function renderGeneratedImageActivity(
	savedImage: SavedGeneratedImage,
	options: { expanded?: boolean },
	theme: any,
): string {
	const marker = theme.fg("success", "•");
	const latest = theme.fg("muted", savedImage.latestRelativePath);
	let text = `${marker} ${theme.bold("Generated image")}${theme.fg("dim", " · ")}${latest}`;
	if (!options.expanded) return text;

	const details: string[] = [];
	if (savedImage.revisedPrompt) {
		details.push(
			`${theme.fg("accent", "Prompt")} ${theme.fg("muted", shortenPrompt(savedImage.revisedPrompt, 140))}`,
		);
	}
	details.push(`${theme.fg("accent", "File")} ${theme.fg("muted", savedImage.relativePath)}`);
	details.push(`${theme.fg("accent", "Latest")} ${theme.fg("muted", savedImage.latestRelativePath)}`);

	for (const [index, detail] of details.entries()) {
		const prefix = index === details.length - 1 ? "  └ " : "  ├ ";
		text += `\n${theme.fg("dim", prefix)}${detail}`;
	}
	return text;
}

export function renderImageGenerationMessage(
	message: { content: unknown; details?: ImageDisplayMessageDetails },
	options: { expanded?: boolean },
	theme: any,
) {
	const savedImage = message.details?.savedImages?.[0];
	const container = new Container();
	if (savedImage) {
		container.addChild(textComponent(renderGeneratedImageActivity(savedImage, options, theme)));
		const preview = readPreviewImageFromPathSync(savedImage.absolutePath);
		if (preview) {
			container.addChild(new Spacer(1));
			container.addChild(
				new KittyVirtualImage(
					preview.data,
					preview.mimeType,
					{
						fallbackColor: (text: string) => theme.fg("toolOutput", text),
					},
					{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
				),
			);
		}
		return container;
	}
	return textComponent(`${theme.fg("success", "•")} ${theme.bold("Generated image")}`);
}

export function registerNativeActivityMessageRenderers(pi: ExtensionAPI): void {
	if (registeredRendererApis.has(pi)) return;
	registeredRendererApis.add(pi);
	registerExtensionMessageRenderer(pi, IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, renderOptions, theme) =>
		renderImageGenerationMessage(message as any, renderOptions, theme),
	);
	registerExtensionMessageRenderer(pi, WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, renderOptions, theme) =>
		renderWebSearchMessage(message as any, renderOptions, theme),
	);
}

export function renderWebSearchMessage(
	message: { content: unknown; details?: { searches?: SurfacedWebSearch[] } },
	options: { expanded?: boolean },
	theme: any,
) {
	const searches = message.details?.searches ?? [];
	let text = renderWebSearchActivity(searches, theme);
	if (options.expanded) {
		const content = typeof message.content === "string" ? message.content : "";
		if (content.trim()) text += `\n${theme.fg("dim", content)}`;
	}
	return textComponent(text);
}
