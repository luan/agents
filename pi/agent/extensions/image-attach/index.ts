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
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";

import { type PreviewImage, readPreviewImageFromPathSync } from "../shared/image-preview";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";
import {
	type AnimationMount,
	type EditorUi,
	type RenderTheme,
	registerExtensionMessageRenderer,
	sharedAnimationRenderScheduler,
	textComponent,
} from "../shared/tui";
import { installEditorHandleHighlight } from "./editor";
import {
	beginPendingHandle,
	endPendingHandle,
	formatHandle,
	IMAGE_HANDLE,
	PENDING_HANDLE,
	setHandleThumbnail,
} from "./handles";
import { renderThumbnailCells } from "./thumbnail";

const PREVIEW_MESSAGE_TYPE = "image-attach-preview";
const RENDER_TARGET_WIDGET_KEY = "image-attach-render";
const PENDING_FRAME_MS = 120;

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
export function resolveImagePath(token: string, cwd: string): string | undefined {
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
	const seenData = new Set(existing.map((image) => image.data));
	const seenPaths = new Set<string>();
	const attachments: Array<{ path: string; image: ImageContent }> = [];

	for (const path of paths) {
		if (seenPaths.has(path)) continue;
		seenPaths.add(path);
		const image = await loadImage(path);
		if (!image || seenData.has(image.data)) continue;
		seenData.add(image.data);
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
 * file path. ponytail: pinned to pi's dist layout; if an upgrade moves the file, capture
 * degrades to "no image found" and the built-in ctrl+v still works. Drop this in favour of a
 * real export when pi publishes one.
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
 * Write the clipboard image to a temp file and leave its handle in the editor. False when the
 * clipboard holds no image, in which case the placeholder is taken back out again.
 */
async function captureClipboardImage(ctx: ExtensionContext): Promise<boolean> {
	beginPendingHandle();
	ctx.ui.pasteToEditor(`${PENDING_HANDLE} `);
	const animation = startPendingAnimation();
	try {
		const clipboard = await loadClipboardImageModule();
		const image = await clipboard?.readClipboardImage().catch(() => undefined);
		if (!image) return false;

		const extension = clipboard?.extensionForImageMimeType(image.mimeType) ?? "png";
		const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
		await writeFile(path, Buffer.from(image.bytes));
		const { index, handle } = registerPastedImage(path);
		// The spinner is still up, so pay for the thumbnail before revealing the handle.
		setHandleThumbnail(index, await renderThumbnailCells(path));
		replacePendingHandle(ctx, handle);
		return true;
	} catch {
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
 * ponytail: `setEditorText` is the only way an extension can rewrite the buffer, and it clears
 * the editor's paste-marker store — a `[paste #N]` blob pasted earlier in the same message ends
 * up inlined rather than collapsed. Content is preserved either way. Revisit if pi ever exposes
 * a ranged edit.
 */
function replacePendingHandle(ctx: ExtensionContext, handle: string | undefined): void {
	const text = ctx.ui.getEditorText();
	if (!text.includes(PENDING_HANDLE)) return;
	ctx.ui.setEditorText(
		handle === undefined ? text.replace(`${PENDING_HANDLE} `, "") : text.replace(PENDING_HANDLE, handle),
	);
	requestRender();
}

/**
 * ponytail: macOS only. Text paste normally never reaches this extension — it matters just
 * for the terminals whose cmd+v has to be remapped onto ctrl+v, so this keeps that remap from
 * costing you ordinary paste. Add wl-paste/xclip/PowerShell branches when a Linux box needs it.
 */
function readClipboardText(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	const result = spawnSync("pbpaste", { encoding: "utf-8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
	return result.status === 0 && result.stdout ? result.stdout : undefined;
}

// ---------------------------------------------------------------------------
// Repaint
// ---------------------------------------------------------------------------

type RenderTarget = { requestRender(): void };

type WidgetUi = {
	setWidget?: (
		key: string,
		content: ((tui: RenderTarget) => { render: () => string[]; invalidate: () => void }) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => void;
};

/**
 * Editing the buffer from an extension leaves the screen stale until the next keystroke, and
 * `ExtensionUIContext` has no repaint call. A zero-row widget is the one hook whose factory
 * hands over the TUI, so claim one and keep it purely as a repaint handle.
 */
let renderTarget: RenderTarget | undefined;

function claimRenderTarget(ctx: ExtensionContext): void {
	const ui = ctx.ui as unknown as WidgetUi;
	if (typeof ui.setWidget !== "function") return;
	ui.setWidget(
		RENDER_TARGET_WIDGET_KEY,
		(tui) => {
			renderTarget = tui;
			return { render: () => [], invalidate: () => {} };
		},
		{ placement: "belowEditor" },
	);
}

function requestRender(): void {
	renderTarget?.requestRender();
}

/** Repaint on the spinner cadence so the pending handle animates in place. */
function startPendingAnimation(): AnimationMount | undefined {
	requestRender();
	return renderTarget && sharedAnimationRenderScheduler.mount(renderTarget, PENDING_FRAME_MS);
}

// ---------------------------------------------------------------------------
// Transcript preview
// ---------------------------------------------------------------------------

/** Previews shell out to `magick`, and render runs on every frame. Keep them per path. */
const previewCache = new Map<string, PreviewImage | undefined>();

function cachedPreview(path: string): PreviewImage | undefined {
	if (!previewCache.has(path)) previewCache.set(path, readPreviewImageFromPathSync(path));
	return previewCache.get(path);
}

function renderPreviewMessage(paths: readonly string[], theme: RenderTheme): Container {
	const container = new Container();
	for (const [index, path] of paths.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const label = theme.bold?.("Attached image") ?? "Attached image";
		container.addChild(
			textComponent(
				`${theme.fg("success", "•")} ${label}${theme.fg("dim", " · ")}${theme.fg("muted", basename(path))}`,
			),
		);
		const preview = cachedPreview(path);
		if (preview) {
			container.addChild(
				new KittyVirtualImage(
					preview.data,
					preview.mimeType,
					{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
					{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
				),
			);
		}
	}
	return container;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function imageAttachExtension(pi: ExtensionAPI, deps?: { loadImage: ImageLoader }): void {
	const readImage = deps?.loadImage ?? createReadImageLoader();
	let unsubscribeTerminalInput: (() => void) | undefined;

	registerExtensionMessageRenderer(pi, PREVIEW_MESSAGE_TYPE, (message, _options, theme) => {
		const paths = (message.details as { paths?: string[] } | undefined)?.paths ?? [];
		return renderPreviewMessage(paths, theme as unknown as RenderTheme);
	});

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
		claimRenderTarget(ctx);
		// Rewrite the paste rather than consuming it: the editor still sees a paste (atomic
		// insert, one undo step) and the TUI still repaints on its own afterwards.
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			const path = pastedImagePath(data, ctx.cwd);
			if (!path) return undefined;
			const { index, handle } = registerPastedImage(path);
			// Nothing is waiting on this paste, so let the handle land as text and colour it in
			// once the thumbnail is ready.
			void renderThumbnailCells(path).then((cells) => {
				if (!cells) return;
				setHandleThumbnail(index, cells);
				requestRender();
			});
			return { data: bracketedPaste(`${handle} `) };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !ctx.model?.input?.includes("image")) {
			return { action: "continue" };
		}
		const attachments = await collectImageAttachments(event.text, ctx.cwd, event.images ?? [], (path) =>
			readImage(path, ctx),
		);
		if (attachments.length === 0) return { action: "continue" };

		pi.sendMessage({
			customType: PREVIEW_MESSAGE_TYPE,
			content: "",
			display: true,
			details: { paths: attachments.map((attachment) => attachment.path) },
		});

		return {
			action: "transform",
			text: appendHandlePaths(event.text, resolveImageHandles(event.text)),
			images: [...(event.images ?? []), ...attachments.map((attachment) => attachment.image)],
		};
	});
}

function createReadImageLoader(): ImageLoader {
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
