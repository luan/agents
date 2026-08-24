import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { attachmentFileTag, type ImageAttachmentStore, replaceAttachmentToken } from "../core/attachments.ts";
import type { ViewImageNativeOutput } from "../tools/view-image/result.ts";

type PromptImage = NonNullable<InputEvent["images"]>[number];

export interface ImageAttachmentTransform {
	text: string;
	images: PromptImage[];
	failures: Array<{ path: string; message: string }>;
}

export async function transformPendingImageAttachments(
	event: Pick<InputEvent, "text" | "images">,
	store: ImageAttachmentStore,
	load: (path: string) => Promise<ViewImageNativeOutput>,
): Promise<ImageAttachmentTransform | undefined> {
	const pending = store.inText(event.text);
	if (pending.length === 0) return undefined;
	let text = event.text;
	const images: PromptImage[] = [...(event.images ?? [])];
	const failures: ImageAttachmentTransform["failures"] = [];
	for (const attachment of pending) {
		try {
			const image = await load(attachment.path);
			text = replaceAttachmentToken(text, attachment, attachmentFileTag(image.path));
			images.push({ type: "image", data: image.data, mimeType: image.mimeType });
		} catch (error) {
			text = replaceAttachmentToken(text, attachment, attachment.path);
			failures.push({ path: attachment.path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	store.clear();
	return { text, images, failures };
}
