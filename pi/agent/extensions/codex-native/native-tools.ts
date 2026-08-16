import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readImageDimensions } from "../shared/image-dimensions";
import {
	collectRecentSessionImages,
	IMAGE_GENERATION_SCHEMA,
	type ImageGenerationArgs,
	loadReferencedImages,
	readImageGenerationArgs,
	requestCodexGeneratedImage,
} from "./image-gen";

export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";
export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
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

export function supportsImageInputs(model: ExtensionContext["model"]): boolean {
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
	const dimensions = readImageDimensions(image.result, mimeType);
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

const IMAGE_GENERATION_DESCRIPTION = [
	"Render an image from a prompt with OpenAI Codex `image_generation`.",
	"Outputs are saved under `.pi/openai-codex-images/` and mirrored to `latest.png`, and the result carries the artifact path.",
	"Pass `referenced_image_paths` to edit or match local images, or `num_last_images_to_include` to reuse the most recent images in this session; never both.",
].join(" ");

export function createImageGenerationTool(): ToolDefinition<any> {
	return {
		name: IMAGE_GENERATION_TOOL_NAME,
		label: IMAGE_GENERATION_TOOL_NAME,
		description: IMAGE_GENERATION_DESCRIPTION,
		promptSnippet: IMAGE_GENERATION_DESCRIPTION,
		parameters: Type.Unsafe<ImageGenerationArgs>(IMAGE_GENERATION_SCHEMA),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx?.model)) {
				throw new Error("image_generation needs an openai-codex model that accepts image input");
			}
			const { prompt, referencedImagePaths, lastImageCount } = readImageGenerationArgs(params);
			const cwd = ctx?.cwd ?? process.cwd();
			const referenceImages =
				referencedImagePaths.length > 0
					? await loadReferencedImages(cwd, referencedImagePaths)
					: await collectRecentSessionImages(ctx, lastImageCount ?? 0);
			const generated = await requestCodexGeneratedImage({ prompt, referenceImages, ctx, signal });
			const savedImage = await saveOpenAICodexGeneratedImage(cwd, {
				...generated,
				revisedPrompt: generated.revisedPrompt ?? prompt,
			});
			markGeneratedImageDisplayed(generated.responseId, generated.callId);
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: buildGeneratedImageArtifactResult([savedImage]) },
			];
			// Re-checked rather than assumed: `supportsNativeImageGeneration` implies it today (:110), and a model that
			// cannot read an image must get the path with no pixels.
			if (supportsImageInputs(ctx?.model)) {
				content.push({ type: "image", data: generated.result, mimeType: savedImage.mimeType });
			}
			return { content, details: { savedImages: [savedImage], referenceCount: referenceImages.length } };
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
	};
}
