import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerViewImageCodeModeAdapter } from "./code-mode-adapter.ts";
import { ImageAttachmentStore } from "./core/attachments.ts";
import { resolveViewImageBinary } from "./native/binary.ts";
import { labelNativeImageAttachments } from "./native-attachments.ts";
import { runViewImageBinary } from "./native/view-image.ts";
import { transformPendingImageAttachments } from "./runtime/attachments.ts";
import { installImageAttachmentSession } from "./runtime/editor-attachments.ts";
import { configureViewImageToolForModel, createViewImageTool } from "./tools/view-image/definition.ts";

export default function viewImageExtension(pi: ExtensionAPI): void {
	const tool = createViewImageTool();
	const attachments = new ImageAttachmentStore();
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
			runViewImageBinary(resolveViewImageBinary(), { path, detail: "original" }, context.cwd),
		);
		if (!transformed) return { action: "continue" };
		for (const failure of transformed.failures) {
			context.ui.notify(`Could not attach ${failure.path}: ${failure.message}`, "warning");
		}
		return { action: "transform", text: transformed.text, images: transformed.images };
	});
	pi.on("context", (event) => {
		const messages = labelNativeImageAttachments(event.messages);
		return messages ? { messages } : undefined;
	});
	const disposeCodeModeAdapter = registerViewImageCodeModeAdapter(tool);
	pi.on("session_shutdown", (event) => {
		removeImagePasteSession?.();
		removeImagePasteSession = undefined;
		attachments.clear();
		if (event.reason === "reload" || event.reason === "quit") disposeCodeModeAdapter();
	});
}
