import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Tool renderers pull image blocks out of `result.content` so the TUI draws them once through
 * KittyVirtualImage instead of twice. Core hands renderers the very array the session message
 * holds, so that removal also hides the image from the model — which then reaches for OCR
 * instead of looking. Keep the blocks here and add them back to every outgoing request.
 */
const retainedImages = new Map<string, ImageContent[]>();
const registeredApis = new WeakSet<object>();

function isImageBlock(item: unknown): item is ImageContent {
	const block = item as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
	return !!block && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

/** Drop image blocks from the rendered result, keeping them for the model. */
export function detachToolResultImages(toolCallId: string | undefined, result: { content?: unknown[] }): void {
	const content = result.content ?? [];
	const images = content.filter(isImageBlock);
	if (images.length > 0 && toolCallId) retainedImages.set(toolCallId, images);
	content.splice(0, content.length, ...content.filter((item) => !isImageBlock(item)));
}

// Loose on purpose: this is called with both ExtensionAPI and the narrower api shapes
// extensions declare for themselves.
type ContextCapableApi = { on?: (event: string, handler: (event: any) => any) => void };

type ToolResultMessageLike = { role?: string; toolCallId?: string; content?: unknown[] };

function withRetainedImages(message: ToolResultMessageLike): ToolResultMessageLike {
	if (message?.role !== "toolResult" || !message.toolCallId) return message;
	const images = retainedImages.get(message.toolCallId);
	if (!images || (message.content ?? []).some(isImageBlock)) return message;
	return { ...message, content: [...(message.content ?? []), ...images] };
}

export function registerToolResultImageRestore(pi: ContextCapableApi): void {
	if (!pi.on || registeredApis.has(pi)) return;
	registeredApis.add(pi);
	pi.on("context", (event: { messages: ToolResultMessageLike[] }) => ({
		messages: event.messages.map(withRetainedImages),
	}));
}
