import { promises as fsPromises, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const WEB_SEARCH_ACTIVITY_MESSAGE_TYPE = "codex-web-search-activity";
export const IMAGE_SAVE_DISPLAY_MESSAGE_TYPE = "codex-image-generation-display";
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
	revisedPrompt?: string;
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

export function getOpenAICodexImageDirectory(cwd: string): string {
	return resolve(cwd, OPENAI_CODEX_IMAGE_DIR);
}

export function getOpenAICodexImagePath(
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
	const absolutePath = getOpenAICodexImagePath(workspaceRoot, image.responseId, image.callId, outputFormat);
	const latestAbsolutePath = getOpenAICodexLatestImagePath(workspaceRoot);
	const bytes = Buffer.from(image.result, "base64");
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
		revisedPrompt: image.revisedPrompt,
	};
}

export function buildGeneratedImageDisplayText(
	savedImage: SavedGeneratedImage,
	options?: { expanded?: boolean },
): string {
	const lines: string[] = [];
	if (options?.expanded && savedImage.revisedPrompt) lines.push(`Prompt: ${savedImage.revisedPrompt}`);
	lines.push(`File: ${savedImage.relativePath}`);
	lines.push(`Latest: ${savedImage.latestRelativePath}`);
	return lines.join("\n");
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

export function buildWebSearchSummaryText(searches: SurfacedWebSearch[]): string {
	return searches.length === 1 ? "Searched the web once" : `Searched the web ${searches.length} times`;
}

export function createImageGenerationTool(): ToolDefinition<any> {
	return {
		name: IMAGE_GENERATION_TOOL_NAME,
		label: IMAGE_GENERATION_TOOL_NAME,
		description:
			"Generate an image with native OpenAI Codex image_generation. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `latest.png`.",
		promptSnippet:
			"Generate an image with native OpenAI Codex image_generation. Outputs are saved under `.pi/openai-codex-images/` and mirrored to `latest.png`.",
		parameters: Type.Unsafe<Record<string, never>>({
			type: "object",
			additionalProperties: false,
		}),
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) {
				throw new Error("image_generation is only available with image-capable openai-codex models");
			}
			throw new Error("image_generation is a native openai-codex provider tool and should not execute locally");
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(IMAGE_GENERATION_TOOL_NAME)), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Container();
			const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
			return new Text(theme.fg("dim", text), 0, 0);
		},
	};
}

export function renderImageGenerationMessage(
	message: { content: unknown; details?: ImageDisplayMessageDetails },
	options: { expanded?: boolean },
	theme: any,
) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const savedImage = message.details?.savedImages?.[0];
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[image_generation]")), 0, 0));
	if (savedImage) {
		box.addChild(
			new Text(`\n${theme.fg("customMessageText", buildGeneratedImageDisplayText(savedImage, options))}`, 0, 0),
		);
		try {
			const data = readFileSync(savedImage.absolutePath).toString("base64");
			box.addChild(new Spacer(1));
			box.addChild(
				new Image(
					data,
					`image/${savedImage.outputFormat}`,
					{
						fallbackColor: (text: string) => theme.fg("customMessageText", text),
					},
					{ maxWidthCells: 60 },
				),
			);
		} catch {
			// Image previews are best-effort; the saved file path above is the durable output.
		}
	}
	return box;
}

export function renderWebSearchMessage(
	message: { content: unknown; details?: { searches?: SurfacedWebSearch[] } },
	options: { expanded?: boolean },
	theme: any,
) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const searches = message.details?.searches ?? [];
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(buildWebSearchSummaryText(searches))), 0, 0));
	if (options.expanded) {
		const content = typeof message.content === "string" ? message.content : "";
		box.addChild(new Text(`\n${theme.fg("customMessageText", content)}`, 0, 0));
	}
	return box;
}
