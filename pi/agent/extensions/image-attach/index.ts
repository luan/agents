/**
 * image-attach — pasted and referenced images reach the model as image content.
 *
 * A screenshot path arrives as plain text, so a multimodal model has to spend tool calls
 * (read → view_image → OCR) to look at something it could have seen in the prompt. Three
 * pieces cover the whole path from clipboard to model:
 *
 *  1. Clipboard capture (ctrl+v) writes the bytes to a temp file and inserts a compact
 *     `[image #N]` handle instead of a wall of path — spinning in place while the clipboard is
 *     read, then carrying a one-row thumbnail of itself. `./editor.ts` tints it and makes it
 *     atomic; a paste that is just an image path (bootty's cmd+v, a dragged file) becomes the
 *     same handle.
 *  2. The `input` hook attaches every handle and every image path in the message as native
 *     image content, so the model sees the pixels. Text-only models get nothing attached.
 *  3. A display-only transcript row renders each attached image inline, since pi's user
 *     message component only knows how to draw text.
 *
 * Loading goes through the built-in read tool so images inherit its format detection,
 * size caps, and Photon downscaling.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { EditorUi } from "../shared/tui";
import { installEditorHandleHighlight, removeEditorHandleHighlight } from "./editor";
import {
	beginPendingHandle,
	clearHandleThumbnail,
	clearHandleThumbnails,
	endPendingHandle,
	formatHandle,
	IMAGE_HANDLE,
	PENDING_HANDLE,
	setHandleThumbnail,
} from "./handles";
import { magickBuffer } from "./magick";
import {
	claimImageRenderTarget,
	clearImagePresentation,
	registerImagePreviewRenderer,
	requestImageRender,
	startPendingImageAnimation,
} from "./presentation";
import { renderThumbnailCells } from "./thumbnail";

const PREVIEW_MESSAGE_TYPE = "image-attach-preview";

/**
 * Path-shaped tokens ending in an image extension: absolute, `~/`, or `./`. Bare filenames
 * are left alone so ordinary words like `diagram.png` in prose stay prose. `\ ` is matched
 * because terminal drag-and-drop escapes spaces that way, and the lookbehind keeps a URL
 * scheme (`https://host/a.png`) from reading as a path.
 */
const IMAGE_PATH_TOKEN = /(?<![:\w/])(?:\/|~\/|\.{1,2}\/)(?:\\ |[^\s)"'<>`])+\.(?:png|jpe?g|gif|webp)/gi;

/** A bracketed paste delivered as one chunk — pi-tui reassembles split pastes before this. */
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

function bracketedPaste(text: string): string {
	return `\x1b[200~${text}\x1b[201~`;
}

/** Handle number → temp file, so submit can turn `[image #3]` back into bytes. */
const ownedTempImages = new Set<string>();
let imageStateGeneration = 0;
const pastedImages = new Map<number, string>();
let pastedImageCount = 0;

/** The handle for a file, reused when the same file is pasted twice. */
function registerPastedImage(path: string): { index: number; handle: string } {
	for (const [index, known] of pastedImages) {
		if (known === path) return { index, handle: formatHandle(index) };
	}
	pastedImageCount += 1;
	pastedImages.set(pastedImageCount, path);
	return { index: pastedImageCount, handle: formatHandle(pastedImageCount) };
}

/** Point an existing handle at a different file, once a copy of it exists. */
function repointHandle(index: number, path: string): void {
	pastedImages.set(index, path);
}
function removeOwnedTempImage(path: string): void {
	ownedTempImages.delete(path);
	try {
		unlinkSync(path);
	} catch {}
}

/**
 * The image file a paste consists of, if that is all it is. bootty pastes a temp-file path when
 * the clipboard holds image bytes, and shell-quotes paths that need it; dragging an image onto
 * the terminal arrives the same way. Anything that is not one existing image file is left alone.
 */
export function pastedImagePath(data: string, cwd: string): string | undefined {
	const payload = BRACKETED_PASTE.exec(data)?.[1]?.trim();
	if (!payload || payload.includes("\n")) return undefined;
	const unquoted = /^'.*'$/.test(payload) ? payload.slice(1, -1).replaceAll("'\\''", "'") : payload;
	if (!/\.(?:png|jpe?g|gif|webp)$/i.test(unquoted)) return undefined;
	return resolveImagePath(unquoted, cwd);
}

export function findImagePathTokens(text: string): string[] {
	return [...new Set(text.match(IMAGE_PATH_TOKEN) ?? [])];
}

/** Absolute path of an existing image file, or undefined. */
function resolveImagePath(token: string, cwd: string): string | undefined {
	const unescaped = token.replace(/\\ /g, " ");
	const expanded = unescaped.startsWith("~/") ? resolve(homedir(), unescaped.slice(2)) : unescaped;
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	try {
		if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return absolute;
}

/** Handles in `text` paired with the temp file they stand for, in text order. */
export function resolveImageHandles(
	text: string,
	handles: ReadonlyMap<number, string> = pastedImages,
): Array<{ handle: string; path: string }> {
	const resolved: Array<{ handle: string; path: string }> = [];
	for (const match of text.matchAll(IMAGE_HANDLE)) {
		const path = handles.get(Number(match[1]));
		if (path && !resolved.some((entry) => entry.path === path)) resolved.push({ handle: match[0], path });
	}
	return resolved;
}

function isImageContent(item: unknown): item is ImageContent {
	const block = item as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
	return !!block && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

type LoadImage = (path: string) => Promise<ImageContent | undefined>;
type ImageLoader = (path: string, ctx: ExtensionContext) => Promise<ImageContent | undefined>;

// The one key for image sameness: pi's processImage output, via file-processor.js:36 or read.js:168.
export function imageIdentity(image: ImageContent): string {
	return createHash("sha256").update(image.data).digest("base64");
}

/**
 * Load every image the message points at — handles first, then bare paths — skipping anything
 * that repeats, fails to load, or is already attached.
 */
export async function collectImageAttachments(
	text: string,
	cwd: string,
	existing: readonly ImageContent[],
	loadImage: LoadImage,
	handles: ReadonlyMap<number, string> = pastedImages,
): Promise<Array<{ path: string; image: ImageContent }>> {
	const paths = [
		...resolveImageHandles(text, handles).map((entry) => entry.path),
		...findImagePathTokens(text).flatMap((token) => resolveImagePath(token, cwd) ?? []),
	];
	const seen = new Set(existing.map(imageIdentity));
	const seenPaths = new Set<string>();
	const attachments: Array<{ path: string; image: ImageContent }> = [];

	for (const path of paths) {
		if (seenPaths.has(path)) continue;
		seenPaths.add(path);
		const image = await loadImage(path);
		if (!image) continue;
		const identity = imageIdentity(image);
		if (seen.has(identity)) continue;
		seen.add(identity);
		attachments.push({ path, image });
	}

	return attachments;
}

/**
 * Name the file behind each handle on its own line. The handle keeps the editor readable;
 * this line is what lets the model re-read, crop, or diff the file it was shown.
 */
export function appendHandlePaths(text: string, handles: Array<{ handle: string; path: string }>): string {
	if (handles.length === 0) return text;
	return [text, "", ...handles.map((entry) => `${entry.handle} ${entry.path}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Clipboard capture
// ---------------------------------------------------------------------------

type ClipboardImageModule = {
	readClipboardImage: () => Promise<{ bytes: Uint8Array; mimeType: string } | null | undefined>;
	extensionForImageMimeType: (mimeType: string) => string | null;
};

/**
 * pi's clipboard reader already covers NSPasteboard, wl-paste, xclip, PowerShell, and
 * Photon format conversion, but `exports` only publishes the package root — so reach it by
 * file path. Pinned to pi's dist layout; if an upgrade moves the file, capture degrades to
 * "no image found" and the built-in ctrl+v still works.
 */
async function loadClipboardImageModule(): Promise<ClipboardImageModule | undefined> {
	try {
		return (await import(
			"../../node_modules/@earendil-works/pi-coding-agent/dist/utils/clipboard-image.js"
		)) as ClipboardImageModule;
	} catch {
		return undefined;
	}
}

/**
 * Longest edge a handle's image keeps. Mirrors the ceiling pi's own read tool applies, so the file
 * a handle points at is already the size the model will be shown.
 */
const MAX_ATTACHMENT_EDGE = 2000;

const NORMALIZE_ARGS = ["-strip", "-resize", `${MAX_ATTACHMENT_EDGE}x${MAX_ATTACHMENT_EDGE}>`, "png:-"];

/** Rewrite a temp file we created as a normalized PNG. Left as-is if `magick` is unavailable. */
async function normalizeInPlace(path: string): Promise<void> {
	const png = await magickBuffer(path, NORMALIZE_ARGS);
	if (png?.length) await writeFile(path, png);
}

/**
 * Copy an image we did not create into a normalized temp PNG of our own.
 *
 * A file-flavoured clipboard (CleanShot and friends put the saved file on the pasteboard) makes the
 * terminal paste that file's own path, so a handle would otherwise point into someone's screenshot
 * library at whatever retina size it was saved at. Taking a copy gives both paste routes the same
 * kind of file, and keeps the conversation independent of a library that prunes itself.
 */
export async function adoptImageFile(path: string): Promise<string> {
	const generation = imageStateGeneration;
	const png = await magickBuffer(path, NORMALIZE_ARGS);
	if (!png?.length) return path;
	const target = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
	await writeFile(target, png);
	if (generation !== imageStateGeneration) {
		removeOwnedTempImage(target);
		return path;
	}
	ownedTempImages.add(target);
	return target;
}

/**
 * Write the clipboard image to a temp file and leave its handle in the editor. False when the
 * clipboard holds no image, in which case the placeholder is taken back out again.
 */
async function captureClipboardImage(ctx: ExtensionContext): Promise<boolean> {
	beginPendingHandle();
	ctx.ui.pasteToEditor(`${PENDING_HANDLE} `);
	const animation = startPendingImageAnimation();
	const generation = imageStateGeneration;
	let path: string | undefined;
	let index: number | undefined;
	try {
		const clipboard = await loadClipboardImageModule();
		const image = await clipboard?.readClipboardImage().catch(() => undefined);
		if (!image) return false;

		const extension = clipboard?.extensionForImageMimeType(image.mimeType) ?? "png";
		path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
		await writeFile(path, Buffer.from(image.bytes));
		ownedTempImages.add(path);
		await normalizeInPlace(path);
		if (generation !== imageStateGeneration) {
			removeOwnedTempImage(path);
			return false;
		}
		const registered = registerPastedImage(path);
		index = registered.index;
		// The spinner is still up, so pay for the thumbnail before revealing the handle.
		setHandleThumbnail(index, await renderThumbnailCells(path));
		if (generation !== imageStateGeneration) {
			pastedImages.delete(index);
			clearHandleThumbnail(index);
			removeOwnedTempImage(path);
			return false;
		}
		replacePendingHandle(ctx, registered.handle);
		return true;
	} catch {
		if (index !== undefined) {
			pastedImages.delete(index);
			clearHandleThumbnail(index);
		}
		if (path) removeOwnedTempImage(path);
		return false;
	} finally {
		animation?.dispose();
		endPendingHandle();
		replacePendingHandle(ctx, undefined);
	}
}

/**
 * Swap the placeholder for the finished handle, or drop it (with its trailing space) when the
 * capture came back empty. Nothing happens once the placeholder is already gone.
 *
 * `setEditorText` is the only way an extension can rewrite the buffer, and it clears the
 * editor's paste-marker store — a `[paste #N]` blob pasted earlier in the same message ends
 * up inlined rather than collapsed. Content is preserved either way.
 */
function replacePendingHandle(ctx: ExtensionContext, handle: string | undefined): void {
	const text = ctx.ui.getEditorText();
	if (!text.includes(PENDING_HANDLE)) return;
	ctx.ui.setEditorText(
		handle === undefined ? text.replace(`${PENDING_HANDLE} `, "") : text.replace(PENDING_HANDLE, handle),
	);
	requestImageRender();
}

/**
 * macOS only. Text paste normally never reaches this extension — it matters just for the
 * terminals whose cmd+v has to be remapped onto ctrl+v, so this keeps that remap from costing
 * you ordinary paste.
 */
function readClipboardText(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	const result = spawnSync("pbpaste", { encoding: "utf-8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
	return result.status === 0 && result.stdout ? result.stdout : undefined;
}

// ---------------------------------------------------------------------------
// Repaint
// ---------------------------------------------------------------------------

function cleanupImageState(): void {
	imageStateGeneration += 1;
	for (const path of ownedTempImages) removeOwnedTempImage(path);
	pastedImages.clear();
	pastedImageCount = 0;
	clearHandleThumbnails();
	endPendingHandle();
	clearImagePresentation();
}
process.once("exit", cleanupImageState);

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function imageAttachExtension(pi: ExtensionAPI, deps?: { loadImage: ImageLoader }): void {
	const readImage = deps?.loadImage ?? createReadImageLoader();
	let unsubscribeTerminalInput: (() => void) | undefined;

	registerImagePreviewRenderer(pi, PREVIEW_MESSAGE_TYPE);

	// Display-only: the images themselves ride along on the user message.
	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== PREVIEW_MESSAGE_TYPE,
		),
	}));

	pi.registerShortcut("ctrl+v", {
		description: "Paste image from clipboard",
		handler: async (ctx: ExtensionContext) => {
			if (await captureClipboardImage(ctx)) return;
			const text = readClipboardText();
			if (text) ctx.ui.pasteToEditor(text);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (!ctx.hasUI) return;
		installEditorHandleHighlight(ctx.ui as unknown as EditorUi);
		claimImageRenderTarget(ctx);
		// Rewrite the paste rather than consuming it: the editor still sees a paste (atomic
		// insert, one undo step) and the TUI still repaints on its own afterwards.
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			const path = pastedImagePath(data, ctx.cwd);
			if (!path) return undefined;
			const { index, handle } = registerPastedImage(path);
			const generation = imageStateGeneration;
			// The handle has to land in this tick, so copy and draw behind it: the original stays
			// attachable until the copy exists, and the handle then follows the copy.
			void adoptImageFile(path)
				.then(async (adopted) => {
					if (generation !== imageStateGeneration) return;
					const thumbnail = await renderThumbnailCells(adopted);
					if (generation !== imageStateGeneration) return;
					repointHandle(index, adopted);
					setHandleThumbnail(index, thumbnail);
					requestImageRender();
				})
				.catch(() => {});
			return { data: bracketedPaste(`${handle} `) };
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) removeEditorHandleHighlight(ctx.ui as unknown as EditorUi);
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		cleanupImageState();
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !ctx.model?.input?.includes("image")) {
			return { action: "continue" };
		}
		const attachments = await collectImageAttachments(event.text, ctx.cwd, event.images ?? [], (path) =>
			readImage(path, ctx),
		);
		if (attachments.length === 0) return { action: "continue" };
		// Re-encode only accepted attachments; a shrunk payload must never reach imageIdentity.
		const images = await Promise.all(
			attachments.map((attachment) => shrinkAttachment(attachment.path, attachment.image)),
		);

		pi.sendMessage({
			customType: PREVIEW_MESSAGE_TYPE,
			content: "",
			display: true,
			details: { paths: attachments.map((attachment) => attachment.path) },
		});

		return {
			action: "transform",
			text: appendHandlePaths(event.text, resolveImageHandles(event.text)),
			images: [...(event.images ?? []), ...images],
		};
	});
}

/**
 * Attachment payload we accept without re-encoding. A screenshot inside pi's 2000×2000 cap
 * encodes to a small fraction of this; well past it means the file was written with little or no
 * compression, which pi's read tool passes straight through because the *dimensions* are fine.
 */
const MAX_ATTACHMENT_BASE64 = 1024 * 1024;

/**
 * Squeeze an attachment whose bytes are out of proportion to its dimensions. The read tool caps
 * how big an image is, not how wastefully it was encoded — an uncompressed 800×600 PNG sails under
 * every limit and still costs megabytes on the wire. Re-encoding is only kept when it actually
 * wins, so a genuinely dense image is left alone.
 */
async function shrinkAttachment(path: string, image: ImageContent): Promise<ImageContent> {
	if (image.data.length <= MAX_ATTACHMENT_BASE64) return image;
	const reencoded = await magickBuffer(path, NORMALIZE_ARGS);
	if (!reencoded?.length) return image;
	const data = reencoded.toString("base64");
	return data.length < image.data.length ? { type: "image", data, mimeType: "image/png" } : image;
}

export function createReadImageLoader(): ImageLoader {
	const baseRead = createReadToolDefinition(process.cwd());
	return async (path, ctx) => {
		try {
			const result = await baseRead.execute("image-attach", { path }, undefined, undefined, ctx);
			return result.content.find(isImageContent);
		} catch {
			return undefined;
		}
	};
}
