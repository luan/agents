import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findScreenTextRect, type HoverDetailCardMount, mountHoverDetailCard, renderEditorTokenPills } from "pi-libtui";
import type { EditorRegistry } from "pi-libtui/editor";
import type { MouseRegistry } from "pi-libtui/mouse";
import { formatTuicrComments, type TuicrComment } from "./tuicr-review.ts";

const REVIEW_COMMENTS_TOKEN = String.fromCodePoint(0x100001);

/** Keeps live tuicr comments as one atomic attachment in Pi's main editor. */
export class ReviewCommentAttachments {
	private readonly commentsById = new Map<string, TuicrComment>();
	private readonly removeDecorator: () => void;
	private readonly detail: HoverDetailCardMount;
	private pendingSubmittedText: string | undefined;

	constructor(
		private readonly context: ExtensionContext,
		registry: EditorRegistry,
		mouseRegistry: MouseRegistry,
	) {
		this.removeDecorator = registry.registerRenderDecorator({
			id: "pi-tuicr.review-comments",
			decorate: (lines, width) => {
				if (this.commentsById.size === 0) return [...lines];
				return renderEditorTokenPills(lines, width, this.context.ui.theme, [
					{
						token: REVIEW_COMMENTS_TOKEN,
						icon: { glyph: "" },
						label: `${this.commentsById.size} review comments`,
					},
				]).lines;
			},
		});
		this.detail = mountHoverDetailCard({
			id: "pi-tuicr.review-comments-detail",
			theme: context.ui.theme,
			registry: mouseRegistry,
			getTarget: (screen) => {
				const label = ` ${this.commentsById.size} review comments`;
				const rect = this.commentsById.size > 0 ? findScreenTextRect(screen, label) : undefined;
				return rect ? { rect, content: this.detailContent() } : undefined;
			},
		});
	}

	publish(comments: readonly TuicrComment[]): void {
		for (const comment of comments) {
			if (comment.content.trim().length > 0) this.commentsById.set(comment.id, comment);
		}
		if (this.commentsById.size === 0) return;
		const editorText = this.context.ui.getEditorText();
		if (!editorText.includes(REVIEW_COMMENTS_TOKEN)) {
			const separator = editorText.length === 0 || editorText.endsWith(" ") ? "" : " ";
			this.context.ui.setEditorText(`${editorText}${separator}${REVIEW_COMMENTS_TOKEN}`);
		}
	}

	transform(text: string): string | undefined {
		if (this.commentsById.size === 0 || !text.includes(REVIEW_COMMENTS_TOKEN)) return undefined;
		const transformed = text.replaceAll(REVIEW_COMMENTS_TOKEN, formatTuicrComments([...this.commentsById.values()]));
		this.pendingSubmittedText = transformed;
		return transformed;
	}

	accept(message: ReviewCommentMessageBoundary): void {
		if (!this.pendingSubmittedText || messageText(message) !== this.pendingSubmittedText) return;
		this.pendingSubmittedText = undefined;
		this.commentsById.clear();
	}

	dispose(): void {
		this.detail.dispose();
		this.removeDecorator();
		this.commentsById.clear();
		this.pendingSubmittedText = undefined;
		const editorText = this.context.ui.getEditorText();
		if (editorText.includes(REVIEW_COMMENTS_TOKEN)) {
			this.context.ui.setEditorText(editorText.replaceAll(REVIEW_COMMENTS_TOKEN, "").trimEnd());
		}
	}

	private detailContent(): { readonly title: string; readonly rows: readonly string[] } {
		const rows = [...this.commentsById.values()].flatMap((comment, index) => {
			const anchor = comment.location ?? comment.path;
			const type = comment.commentType && comment.commentType !== "none" ? ` · ${comment.commentType}` : "";
			return [`#${index + 1}${type}${anchor ? ` · ${anchor}` : ""}`, `Comment: ${comment.content.trim()}`];
		});
		return { title: `${this.commentsById.size} review comments`, rows };
	}
}

// type-boundary: Pi message events are supplied by the host; this reader consumes only user text content.
type ReviewCommentMessageBoundary = unknown;

function messageText(message: ReviewCommentMessageBoundary): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as { role?: ReviewCommentMessageBoundary; content?: ReviewCommentMessageBoundary };
	if (record.role !== "user") return undefined;
	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return undefined;
	return record.content
		.flatMap((part) =>
			part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
				? [String(part.text)]
				: [],
		)
		.join("");
}
