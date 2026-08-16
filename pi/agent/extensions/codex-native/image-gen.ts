// The cell-side half of codex's `image_gen__imagegen`, the same fix web-run.ts made for `web_search`:
// one Responses request to `codex/responses` carrying `tools: [{type:"image_generation"}]`, so a local
// `execute` can return the image instead of the provider hosting the capability.

import { promises as fsPromises } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { codexChatGptCredentials } from "./codex-auth";
import {
	buildSSEHeaders,
	extractAccountId,
	fetchCodexSSEWithRetries,
	parseSSE,
	resolveCodexUrl,
} from "./codex-transport";

export type ImageGenerationArgs = {
	prompt?: unknown;
	referenced_image_paths?: unknown;
	num_last_images_to_include?: unknown;
};

export type ReferenceImage = {
	data: string;
	mimeType: string;
	source: string;
};

export type GeneratedImagePayload = {
	callId: string;
	result: string;
	responseId?: string;
	outputFormat?: string;
	revisedPrompt?: string;
};

/** Mirrors codex's own `image_gen__imagegen`: the two reference channels are mutually exclusive. */
export const IMAGE_GENERATION_SCHEMA = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description:
				"What to draw or how to edit the referenced images. Describe subject, style and any text to render.",
		},
		referenced_image_paths: {
			type: "array",
			items: { type: "string" },
			description:
				"Local image files to condition on, relative to the workspace or absolute. Use for editing or style transfer. Cannot be combined with num_last_images_to_include.",
		},
		num_last_images_to_include: {
			type: "number",
			description:
				"Reuse this many of the most recent images in the session instead of naming files. Cannot be combined with referenced_image_paths.",
		},
	},
	required: ["prompt"],
	additionalProperties: false,
} as const;

const IMAGE_GENERATION_INSTRUCTIONS = [
	"You render images. Call the image_generation tool exactly once for the request below.",
	"Never ask a clarifying question and never answer with text only.",
	"When the user attaches images, treat them as the material to edit or to match.",
].join(" ");

const MAX_SESSION_IMAGE_SCAN = 200;
const MAX_SELECTED_SESSION_IMAGES = 5;

type ModelLike = {
	id?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
};

type SessionManagerLike = {
	getBranch?: (fromId?: string) => unknown[];
	getSessionId?: () => string | undefined;
};

export type ImageGenerationContext = {
	cwd?: string;
	model?: ModelLike;
	sessionManager?: SessionManagerLike;
};

export function readImageGenerationArgs(params: unknown): {
	prompt: string;
	referencedImagePaths: string[];
	lastImageCount?: number;
} {
	// A cell can still write `tools.image_generation("a red cube")`: with three properties the schema is no longer the
	// single-required shape nested-dispatch.ts:127 wraps, so the bare string arrives here as the whole argument.
	const args = (typeof params === "string" ? { prompt: params } : (params ?? {})) as ImageGenerationArgs;
	const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
	if (!prompt) throw new Error("image_generation needs a prompt describing the image to render.");

	const referencedImagePaths = Array.isArray(args.referenced_image_paths)
		? args.referenced_image_paths.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		: [];
	const rawCount = args.num_last_images_to_include;
	const lastImageCount = typeof rawCount === "number" && Number.isFinite(rawCount) ? Math.floor(rawCount) : undefined;

	if (referencedImagePaths.length > 0 && lastImageCount !== undefined && lastImageCount > 0) {
		throw new Error(
			"image_generation takes referenced_image_paths or num_last_images_to_include, never both. Drop one of the two.",
		);
	}
	if (lastImageCount !== undefined && lastImageCount < 0) {
		throw new Error("image_generation needs num_last_images_to_include to be zero or more.");
	}
	return { prompt, referencedImagePaths, ...(lastImageCount === undefined ? {} : { lastImageCount }) };
}

const MAGIC_MIME_TYPES: ReadonlyArray<{ mimeType: string; matches: (bytes: Buffer) => boolean }> = [
	{ mimeType: "image/png", matches: (bytes) => bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" },
	{ mimeType: "image/jpeg", matches: (bytes) => bytes.subarray(0, 3).toString("hex") === "ffd8ff" },
	{
		mimeType: "image/webp",
		matches: (bytes) =>
			bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
	},
	{ mimeType: "image/gif", matches: (bytes) => bytes.subarray(0, 3).toString("ascii") === "GIF" },
];

function sniffImageMimeType(bytes: Buffer): string | undefined {
	return MAGIC_MIME_TYPES.find((candidate) => candidate.matches(bytes))?.mimeType;
}

/** `resizeImage` applies pi's 2000x2000 / 4.5 MB ceiling, so an 8 MB reference cannot 413 the request. */
async function fitReferenceImage(bytes: Buffer, mimeType: string): Promise<{ data: string; mimeType: string }> {
	const fitted = await resizeImage(bytes, mimeType).catch(() => null);
	return fitted ?? { data: bytes.toString("base64"), mimeType };
}

export async function loadReferencedImages(cwd: string, paths: readonly string[]): Promise<ReferenceImage[]> {
	const images: ReferenceImage[] = [];
	for (const candidate of paths) {
		const absolutePath = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		let bytes: Buffer;
		try {
			bytes = await fsPromises.readFile(absolutePath);
		} catch {
			throw new Error(`image_generation cannot read referenced_image_paths entry ${absolutePath}.`);
		}
		const mimeType = sniffImageMimeType(bytes);
		if (!mimeType)
			throw new Error(`image_generation does not recognise ${absolutePath} as a PNG, JPEG, WebP or GIF.`);
		const fitted = await fitReferenceImage(bytes, mimeType);
		images.push({ data: fitted.data, mimeType: fitted.mimeType, source: absolutePath });
	}
	return images;
}

function contentBlocks(entry: unknown): unknown[] {
	if (!entry || typeof entry !== "object") return [];
	const record = entry as { type?: unknown; message?: { content?: unknown }; content?: unknown };
	if (record.type === "message") return Array.isArray(record.message?.content) ? record.message.content : [];
	if (record.type === "custom_message") return Array.isArray(record.content) ? record.content : [];
	return [];
}

function artifactPaths(text: string): Array<{ path: string; mimeType?: string }> {
	if (!text.includes('"artifacts"')) return [];
	try {
		const parsed = JSON.parse(text) as { artifacts?: Array<{ path?: unknown; mime_type?: unknown }> };
		if (!Array.isArray(parsed.artifacts)) return [];
		return parsed.artifacts
			.filter((artifact): artifact is { path: string; mime_type?: string } => typeof artifact?.path === "string")
			.map((artifact) => ({
				path: artifact.path,
				...(typeof artifact.mime_type === "string" ? { mimeType: artifact.mime_type } : {}),
			}));
	} catch {
		return [];
	}
}

async function referenceFromDisk(path: string, mimeType: string | undefined): Promise<ReferenceImage | undefined> {
	try {
		const bytes = await fsPromises.readFile(path);
		const resolvedMime = sniffImageMimeType(bytes) ?? mimeType;
		if (!resolvedMime) return undefined;
		const fitted = await fitReferenceImage(bytes, resolvedMime);
		return { data: fitted.data, mimeType: fitted.mimeType, source: path };
	} catch {
		return undefined;
	}
}

/**
 * The most recent images on this session's branch, newest last.
 *
 * Three shapes carry one: a `{type:"image"}` block, an `image_generation_call` block whose `item.result` is base64
 * (the hosted path's shape, still in old sessions), and the `{"artifacts":[{path}]}` text this tool returns. The third
 * matters because tool-result-images.ts:23 splices image blocks out of the array the session holds, so a generated
 * image is recoverable only through its saved path.
 */
export async function collectRecentSessionImages(
	ctx: ImageGenerationContext | undefined,
	count: number,
): Promise<ReferenceImage[]> {
	const requestedCount = Math.min(count, MAX_SELECTED_SESSION_IMAGES);
	if (requestedCount <= 0) return [];
	const getBranch = ctx?.sessionManager?.getBranch;
	if (typeof getBranch !== "function") {
		throw new Error(
			"image_generation cannot read session history here, so num_last_images_to_include is unavailable.",
		);
	}
	const entries = getBranch.call(ctx?.sessionManager) ?? [];
	const found: ReferenceImage[] = [];
	const scanned = entries.slice(-MAX_SESSION_IMAGE_SCAN);
	for (let entryIndex = scanned.length - 1; entryIndex >= 0 && found.length < requestedCount; entryIndex--) {
		const blocks = contentBlocks(scanned[entryIndex]);
		for (let blockIndex = blocks.length - 1; blockIndex >= 0 && found.length < requestedCount; blockIndex--) {
			const block = blocks[blockIndex] as {
				type?: unknown;
				data?: unknown;
				mimeType?: unknown;
				text?: unknown;
				item?: { result?: unknown; output_format?: unknown };
			};
			if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				found.push({ data: block.data, mimeType: block.mimeType, source: "session image" });
				continue;
			}
			if (block?.type === "image_generation_call" && typeof block.item?.result === "string") {
				const format = typeof block.item.output_format === "string" ? block.item.output_format : "png";
				found.push({ data: block.item.result, mimeType: `image/${format}`, source: "session image" });
				continue;
			}
			if (block?.type === "text" && typeof block.text === "string") {
				for (const artifact of artifactPaths(block.text).reverse()) {
					if (found.length >= requestedCount) break;
					const image = await referenceFromDisk(artifact.path, artifact.mimeType);
					if (image) found.push(image);
				}
			}
		}
	}
	if (found.length === 0) {
		throw new Error("image_generation found no earlier image in this session to reuse.");
	}
	return found.reverse();
}

export function buildImageGenerationRequestBody(
	modelId: string,
	prompt: string,
	referenceImages: readonly ReferenceImage[],
): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
	for (const image of referenceImages) {
		content.push({ type: "input_image", detail: "auto", image_url: `data:${image.mimeType};base64,${image.data}` });
	}
	return {
		model: modelId,
		store: false,
		stream: true,
		instructions: IMAGE_GENERATION_INSTRUCTIONS,
		input: [{ type: "message", role: "user", content }],
		tools: [{ type: "image_generation", output_format: "png" }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

function codexEventError(event: { type?: unknown; message?: unknown; code?: unknown; response?: unknown }): string {
	const responseError = (event.response as { error?: { message?: unknown; code?: unknown } } | undefined)?.error;
	const message = typeof event.message === "string" && event.message ? event.message : responseError?.message;
	const code = typeof event.code === "string" && event.code ? event.code : responseError?.code;
	if (typeof message === "string" && message) return message;
	if (typeof code === "string" && code) return code;
	return "Codex image_generation request failed";
}

/** Codex SSE event parsing returns one image-generation item for this local tool. */
export async function extractGeneratedImage(events: AsyncIterable<any>): Promise<{
	image?: GeneratedImagePayload;
	text: string;
}> {
	let responseId: string | undefined;
	let text = "";
	for await (const event of events) {
		const type = typeof event?.type === "string" ? event.type : "";
		if (type === "response.created" && typeof event.response?.id === "string") responseId = event.response.id;
		if (type === "error" || type === "response.failed") throw new Error(codexEventError(event));
		if (type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
		if (type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const item = event.item as {
				id?: unknown;
				result?: unknown;
				output_format?: unknown;
				revised_prompt?: unknown;
			};
			if (typeof item.id === "string" && typeof item.result === "string" && item.result) {
				return {
					image: {
						callId: item.id,
						result: item.result,
						...(responseId ? { responseId } : {}),
						...(typeof item.output_format === "string" ? { outputFormat: item.output_format } : {}),
						...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
					},
					text,
				};
			}
		}
	}
	return { text };
}

export async function requestCodexGeneratedImage(options: {
	prompt: string;
	referenceImages: readonly ReferenceImage[];
	ctx: ImageGenerationContext | undefined;
	signal?: AbortSignal;
}): Promise<GeneratedImagePayload> {
	const { token, accountId } = codexChatGptCredentials();
	const model = options.ctx?.model;
	const sessionId = options.ctx?.sessionManager?.getSessionId?.();
	const headers = buildSSEHeaders(model?.headers, undefined, accountId ?? extractAccountId(token), token, sessionId);
	// No model fallback: `gpt-5.5` does not work and is very expensive, and the caller's gate already requires an
	// openai-codex model, so a missing id means the gate was bypassed rather than that a default is wanted.
	if (!model?.id) throw new Error("image_generation needs a resolved openai-codex model; none was on the context.");
	const body = buildImageGenerationRequestBody(model.id, options.prompt, options.referenceImages);
	const response = await fetchCodexSSEWithRetries(resolveCodexUrl(model?.baseUrl), headers, body, {
		signal: options.signal,
	} as Parameters<typeof fetchCodexSSEWithRetries>[3]);
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`Codex image_generation failed (${response.status}): ${detail}`);
	}
	const { image, text } = await extractGeneratedImage(parseSSE(response));
	if (!image) {
		const reason = text.trim() ? `: ${text.trim().slice(0, 300)}` : ".";
		throw new Error(`Codex returned no image for this prompt${reason}`);
	}
	return image;
}
