import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderEditorTokenPills } from "pi-libtui";
import { type EditorRegistry, ensureEditorRegistry } from "pi-libtui/editor";
import type { ImageAttachmentStore } from "../core/attachments.ts";
import { pastedImagePath } from "../core/attachments.ts";

export interface ImageAttachmentSession {
	cwd: string;
	getTheme(): Theme;
	store: ImageAttachmentStore;
}

/** Register image attachments with pi-libtui's shared atomic editor-token path. */
export function installImageAttachmentSession(
	session: ImageAttachmentSession,
	registry: EditorRegistry = ensureEditorRegistry(),
): () => void {
	const removePasteHandler = registry.registerPasteHandler({
		id: "pi-view-image.attach-pasted-image",
		handle(text) {
			const path = pastedImagePath(text, session.cwd);
			return path ? `${session.store.add(path)} ` : undefined;
		},
	});
	const removeRenderDecorator = registry.registerRenderDecorator({
		id: "pi-view-image.render-attachment-tokens",
		decorate(lines, width) {
			const tokens = session.store.presentations(lines.join("\n"));
			return tokens.length === 0 ? [...lines] : renderEditorTokenPills(lines, width, session.getTheme(), tokens).lines;
		},
	});
	return () => {
		removeRenderDecorator();
		removePasteHandler();
	};
}
