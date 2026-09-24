import { imageSettings } from "./contributions/xsettings.ts";
import { type ExtensionAPI, resizeImage } from "@earendil-works/pi-coding-agent";
import { registerViewImageCodeModeAdapter } from "./code-mode-adapter.ts";
import { ImageAttachmentStore } from "./core/attachments.ts";
import { createImageClamp, MAX_IMAGE_DIMENSION } from "./image-limits.ts";
import { resolveViewImageBinary } from "./native/binary.ts";
import { labelNativeImageAttachments } from "./native-attachments.ts";
import { runViewImageBinary } from "./native/view-image.ts";
import { transformPendingImageAttachments } from "./runtime/attachments.ts";
import { installImageAttachmentSession } from "./runtime/editor-attachments.ts";
import { configureViewImageToolForModel, createViewImageTool } from "./tools/view-image/definition.ts";

export default function viewImageExtension(pi: ExtensionAPI): void {
	const disposeSettings = imageSettings.register();
	const tool = createViewImageTool();
	const attachments = new ImageAttachmentStore();
	const clampImages = createImageClamp(async (image) => {
		const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
			maxWidth: MAX_IMAGE_DIMENSION,
			maxHeight: MAX_IMAGE_DIMENSION,
		});
		return resized?.wasResized ? { type: "image", data: resized.data, mimeType: resized.mimeType } : null;
	});
	let removeImagePasteSession: (() => void) | undefined;
	pi.registerTool(tool);
	pi.on("session_start", (_event, context) => {
		configureViewImageToolForModel(tool, context.model);
		attachments.clear();
		removeImagePasteSession?.();
		removeImagePasteSession =
			context.mode === "tui"
				? installImageAttachmentSession({ cwd: context.cwd, getTheme: () => context.ui.theme, store: attachments })
				: undefined;
	});
	pi.on("model_select", (event) => configureViewImageToolForModel(tool, event.model));
	pi.on("input", async (event, context) => {
		const transformed = await transformPendingImageAttachments(event, attachments, (path) =>
			resolveViewImageBinary({ onBuild: (message) => context.ui.notify(message, "info") }).then((binary) =>
				// Pasted screenshots are attached at `high` so oversized captures are resized within provider limits.
				runViewImageBinary(binary, { path, detail: "high" }, context.cwd),
			),
		);
		if (!transformed) return { action: "continue" };
		for (const failure of transformed.failures) {
			context.ui.notify(`Could not attach ${failure.path}: ${failure.message}`, "warning");
		}
		return { action: "transform", text: transformed.text, images: transformed.images };
	});
	pi.on("context", async (event) => {
		const labelled = labelNativeImageAttachments(event.messages);
		const clamped = await clampImages(labelled ?? event.messages);
		const messages = clamped ?? labelled;
		return messages ? { messages } : undefined;
	});
	const disposeCodeModeAdapter = registerViewImageCodeModeAdapter(tool);
	pi.on("session_shutdown", (event) => {
		disposeSettings();
		removeImagePasteSession?.();
		removeImagePasteSession = undefined;
		attachments.clear();
		if (event.reason === "reload" || event.reason === "quit") disposeCodeModeAdapter();
	});
}
