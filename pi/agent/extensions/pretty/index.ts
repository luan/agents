/**
 * pretty — Pretty terminal output for pi built-in tools.
 *
 * @module pretty
 * Enhances:
 *   • read       — compact Explore-row rendering for text files
 *   • view_image — image-only file viewer with inline terminal preview
 *   • bash  — colored exit status, stderr highlighting
 *   • ls    — tree-view directory listing with file-type icons
 *
 * Architecture:
 *   1. Wrap SDK factory tools (createReadTool, createBashTool, etc.)
 *   2. Delegate to original execute() — no behavior changes
 *   3. Attach metadata in result.details for custom renderCall/renderResult
 */

import { open as openFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentToolUpdateCallback,
	BashToolInput,
	ExtensionContext,
	LsToolInput,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { configureImageCapabilities } from "../shared/image-capabilities";
import { createPreviewImageFromBase64 } from "../shared/image-preview";
import { type RegisteredToolDefinition, registerTool } from "../shared/tool-registry.ts";
import { detachToolResultImages, registerToolResultImageRestore } from "../shared/tool-result-images";
import {
	type BashParams,
	createBashPresentation,
	createLsPresentation,
	createViewImagePresentation,
	getTextContent,
	isImageContent,
	type LsParams,
	loadTextComponentCtor,
	rememberRenderPreviews as rememberPresentationPreviews,
	supportsKittyImages,
	type TextComponentCtor,
	type ToolResultLike,
	type ViewImageParams,
} from "./presentation";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool/rendering support
// ---------------------------------------------------------------------------

type ToolExecutor<TParams, TDetails = unknown> = (
	toolCallId: string,
	params: TParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails | undefined>,
	ctx?: ExtensionContext,
) => Promise<ToolResultLike<TDetails>>;

type ToolDefinitionLike<TParams, TDetails = unknown> = {
	name?: string;
	description?: string;
	label?: string;
	promptSnippet?: string;
	parameters?: unknown;
	execute: ToolExecutor<TParams, TDetails>;
};
type ToolFactory<TParams, TDetails = unknown> = (
	cwd: string,
	options?: unknown,
) => ToolDefinitionLike<TParams, TDetails>;
type PiPrettySdk = {
	createReadToolDefinition?: ToolFactory<ReadToolInput>;
	createReadTool?: ToolFactory<ReadToolInput>;
	createBashToolDefinition?: ToolFactory<BashToolInput>;
	createBashTool?: ToolFactory<BashToolInput>;
	createLsToolDefinition?: ToolFactory<LsToolInput>;
	createLsTool?: ToolFactory<LsToolInput>;
	resizeImage?: ResizeImage;
	formatDimensionNote?: (result: ResizedImageLike) => string | undefined;
};
type ResizedImageLike = {
	data: string;
	mimeType: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	wasResized: boolean;
};
type ResizeImage = (
	inputBytes: Uint8Array,
	mimeType: string,
	options?: { maxWidth?: number; maxHeight?: number },
) => Promise<ResizedImageLike | null>;
type PiPrettyApi = {
	registerTool: (tool: unknown) => void;
	on?: (event: string, handler: (event: any) => void) => void;
};

function prettyToolRegistrar(pi: PiPrettyApi): (tool: RegisteredToolDefinition) => void {
	return (tool) => registerTool(pi as never, tool);
}

function setResultDetails<T>(result: ToolResultLike, details: T): void {
	result.details = details;
}

async function detectSupportedImageMimeType(filePath: string): Promise<string | null> {
	const handle = await openFile(filePath, "r");
	try {
		const buffer = Buffer.alloc(12);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (
			bytesRead >= 8 &&
			buffer[0] === 0x89 &&
			buffer[1] === 0x50 &&
			buffer[2] === 0x4e &&
			buffer[3] === 0x47 &&
			buffer[4] === 0x0d &&
			buffer[5] === 0x0a &&
			buffer[6] === 0x1a &&
			buffer[7] === 0x0a
		) {
			return "image/png";
		}
		if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
			return "image/jpeg";
		}
		if (
			bytesRead >= 6 &&
			buffer[0] === 0x47 &&
			buffer[1] === 0x49 &&
			buffer[2] === 0x46 &&
			buffer[3] === 0x38 &&
			(buffer[4] === 0x37 || buffer[4] === 0x39) &&
			buffer[5] === 0x61
		) {
			return "image/gif";
		}
		if (
			bytesRead >= 12 &&
			buffer[0] === 0x52 &&
			buffer[1] === 0x49 &&
			buffer[2] === 0x46 &&
			buffer[3] === 0x46 &&
			buffer[8] === 0x57 &&
			buffer[9] === 0x45 &&
			buffer[10] === 0x42 &&
			buffer[11] === 0x50
		) {
			return "image/webp";
		}
		return null;
	} finally {
		await handle.close();
	}
}

async function imageMimeTypeForExistingPath(filePath: string): Promise<string | null> {
	return detectSupportedImageMimeType(filePath);
}

async function convertImageForKittyPreview(content: ImageContent): Promise<ImageContent> {
	if (!supportsKittyImages() || !content.data || !content.mimeType) return content;

	const preview = await createPreviewImageFromBase64(content.data, content.mimeType);
	return preview
		? ({ ...content, data: preview.data, mimeType: preview.mimeType, sourcePath: preview.sourcePath } as ImageContent)
		: content;
}

const GLANCE_MAX_WIDTH = 720;
const GLANCE_MAX_HEIGHT = 540;

// Reduces the model's own copy through the SDK resizeImage, so the terminal preview in renderPreviews is never the payload.
async function glanceResult(result: ToolResultLike, sdk: PiPrettySdk): Promise<ToolResultLike> {
	const resize = sdk.resizeImage;
	if (!resize) return result;

	const notes: string[] = [];
	const content = await Promise.all(
		(result.content ?? []).map(async (item) => {
			if (!isImageContent(item) || !item.data || !item.mimeType) return item;
			const reduced = await resize(Buffer.from(item.data, "base64"), item.mimeType, {
				maxWidth: GLANCE_MAX_WIDTH,
				maxHeight: GLANCE_MAX_HEIGHT,
			});
			if (!reduced) return item;
			const note = sdk.formatDimensionNote?.(reduced);
			if (note) notes.push(note);
			return { ...item, data: reduced.data, mimeType: reduced.mimeType } as ImageContent;
		}),
	);

	for (const note of notes) content.push({ type: "text", text: note } as TextContent);
	return { ...result, content };
}

async function kittyPreviewImages(result: ToolResultLike): Promise<ImageContent[]> {
	if (!supportsKittyImages()) return [];

	const images = (result.content ?? []).filter(isImageContent);
	return images.length === 0 ? [] : Promise.all(images.map(convertImageForKittyPreview));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Dependencies that can be injected for testing.
 * In production, omit `deps` — the extension uses require() to load them.
 */
interface PiPrettyDeps {
	sdk: PiPrettySdk;
	TextComponent: TextComponentCtor;
}

export default function piPrettyExtension(pi: PiPrettyApi, deps?: PiPrettyDeps): void {
	configureImageCapabilities();
	const registerPrettyTool = prettyToolRegistrar(pi);
	registerToolResultImageRestore(pi);

	let createReadTool: ToolFactory<ReadToolInput> | undefined;
	let createBashTool: ToolFactory<BashToolInput> | undefined;
	let createLsTool: ToolFactory<LsToolInput> | undefined;
	let TextComponent: TextComponentCtor;

	let sdk: PiPrettySdk;

	if (deps) {
		// Test path: use injected dependencies, reset module state
		sdk = deps.sdk;
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		TextComponent = deps.TextComponent;
	} else {
		try {
			sdk = require("@earendil-works/pi-coding-agent");
			createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
			createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
			createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
			TextComponent = loadTextComponentCtor();
		} catch {
			return;
		}
	}
	if (!createReadTool || !TextComponent) return;

	const cwd = process.cwd();
	const viewImageParameters = Type.Object({
		path: Type.String({
			description: "Path to the image file to view (relative or absolute)",
		}),
		fidelity: Type.Optional(
			Type.Union([Type.Literal("readable"), Type.Literal("glance")], {
				description:
					"readable (default) sends the image large enough to read text, labels, and fine detail, and occupies about 3500 tokens of context for a 2000x1500 image. glance sends a 720x540 copy that occupies about 460 tokens, enough to judge layout, colour, or rough counts, and too small to read small text. Choose glance only when you will not need to read anything in the image.",
			}),
		),
	});

	const origImageRead = createReadTool(cwd);

	// ===================================================================
	// view_image — image-only read with forced inline preview
	// ===================================================================

	registerPrettyTool({
		...origImageRead,
		name: "view_image",
		label: "view_image",
		description: "Read/view a local image from the filesystem",
		promptSnippet: "View image file",
		parameters: viewImageParameters,
		...createViewImagePresentation(TextComponent, cwd),

		async execute(
			tid: string,
			params: ViewImageParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			const mimeType = await imageMimeTypeForExistingPath(resolve(cwd, params.path));
			if (!mimeType) {
				throw new Error(
					`view_image only supports jpg, png, gif, and webp image files. Use read for ${params.path}.`,
				);
			}
			const result = (await origImageRead.execute(tid, { path: params.path }, sig, upd, ctx)) as ToolResultLike;
			rememberPresentationPreviews(tid, await kittyPreviewImages(result));
			const output = params.fidelity === "glance" ? await glanceResult(result, sdk) : result;
			if (getCapabilities().images) detachToolResultImages(tid, output);
			return output;
		},
	});

	// ===================================================================
	// bash — colored exit status
	// ===================================================================

	if (createBashTool) {
		const origBash = createBashTool(cwd);

		registerPrettyTool({
			...origBash,
			name: "bash",

			async execute(
				tid: string,
				params: BashParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origBash.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);

				let exitCode: number | null = 0;
				if (textContent) {
					const exitMatch = textContent.match(/(?:exit code|exited with|exit status)[:\s]*(\d+)/i);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					if (textContent.includes("command not found") || textContent.includes("No such file")) {
						exitCode = 1;
					}
				}

				setResultDetails(result, {
					_type: "bashResult",
					text: textContent ?? "",
					exitCode,
					command: params.command ?? "",
				});

				return result;
			},

			...createBashPresentation(TextComponent),
		});
	}

	// ===================================================================
	// ls — tree view with icons
	// ===================================================================

	if (createLsTool) {
		const origLs = createLsTool(cwd);

		registerPrettyTool({
			...origLs,
			name: "ls",

			async execute(
				tid: string,
				params: LsParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origLs.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);
				const fp = params.path ?? cwd;
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				});

				return result;
			},

			...createLsPresentation(TextComponent),
		});
	}
}
