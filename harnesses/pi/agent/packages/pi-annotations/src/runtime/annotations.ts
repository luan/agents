import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SelectionActionRequest } from "pi-libtui/selection";
import type { AnnotationSelection, DraftAnnotation, ResponseAnnotation } from "../core/types.ts";
import { removeTokenAtom, tokenInsertion, type AnnotationStore } from "../core/store.ts";
import { getReactions } from "../config/settings.ts";
import { showCommentOverlay, showReactionOverlay } from "../ui/composer-overlays.ts";
import type { MouseRegistry } from "pi-libtui/mouse";
import type { SelectionPoint } from "pi-libtui/selection";

// type-boundary: Pi session entries contain provider AgentMessage variants; these guards narrow only text-bearing fields.
type PiMessageBoundary = unknown;

function textContent(value: PiMessageBoundary): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const pieces: string[] = [];
	for (const part of value) {
		if (!part || typeof part !== "object") continue;
		const record = part as { type?: PiMessageBoundary; text?: PiMessageBoundary };
		if (
			(record.type === "text" || record.type === "output_text" || record.type === "input_text") &&
			typeof record.text === "string"
		)
			pieces.push(record.text);
	}
	return pieces.length > 0 ? pieces.join("") : undefined;
}

function assistantEntryText(entry: PiMessageBoundary): { id: string; text: string } | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: PiMessageBoundary; id?: PiMessageBoundary; message?: PiMessageBoundary };
	if (
		record.type !== "message" ||
		typeof record.id !== "string" ||
		!record.message ||
		typeof record.message !== "object"
	)
		return undefined;
	const message = record.message as { role?: PiMessageBoundary; content?: PiMessageBoundary };
	if (message.role !== "assistant") return undefined;
	const text = textContent(message.content);
	return text === undefined ? undefined : { id: record.id, text };
}

export function resolveSelection(
	request: SelectionActionRequest,
	ctx: Pick<ExtensionContext, "sessionManager">,
): AnnotationSelection {
	const suppliedId = request.source?.messageId;
	if (suppliedId) {
		return {
			messageId: suppliedId,
			messageIdStability: request.source?.messageIdStability ?? "best-effort",
			text: request.text,
			shape: request.shape,
			start: request.logical.start,
			end: request.logical.end,
			screenStart: request.screen.start,
			screenEnd: request.screen.end,
			...(request.source ? { source: request.source } : {}),
		};
	}
	const matches: Array<{ id: string; offset: number }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const assistant = assistantEntryText(entry);
		if (!assistant) continue;
		let offset = assistant.text.indexOf(request.text);
		while (offset >= 0) {
			matches.push({ id: assistant.id, offset });
			offset = assistant.text.indexOf(request.text, offset + Math.max(1, request.text.length));
		}
	}
	const unique = matches.length === 1 ? matches[0] : undefined;
	const fallbackId = `screen:${request.logical.start.row}:${request.logical.start.col}-${request.logical.end.row}:${request.logical.end.col}`;
	const source = unique
		? {
				messageId: unique.id,
				messageIdStability: "stable" as const,
				offsets: { start: unique.offset, end: unique.offset + request.text.length },
				quote: request.source?.quote ?? { exact: request.text },
			}
		: request.source;
	return {
		messageId: unique?.id ?? fallbackId,
		messageIdStability: unique ? "stable" : "best-effort",
		text: request.text,
		shape: request.shape,
		start: request.logical.start,
		end: request.logical.end,
		screenStart: request.screen.start,
		screenEnd: request.screen.end,
		...(source ? { source } : {}),
	};
}

export async function composeAnnotation(
	request: SelectionActionRequest,
	ctx: ExtensionContext,
	store: AnnotationStore,
	registry: MouseRegistry,
): Promise<boolean> {
	if (!request.text) {
		request.showFeedback?.({ message: "No text selected to annotate.", kind: "warning" });
		return false;
	}
	const selection = resolveSelection(request, ctx);
	const actionAnchor = selectionOverlayAnchor(request);
	if (request.action === "selection.reaction") {
		const reactions = getReactions();
		if (reactions.length === 0) {
			ctx.ui.notify("Configure at least one annotation reaction first.", "warning");
			return false;
		}
		const reaction = await showReactionOverlay(ctx, registry, actionAnchor, reactions, "center");
		if (reaction?.action !== "save") return false;
		store.add(selection, reaction.text);
	} else {
		const comment = await showCommentOverlay(ctx, registry, actionAnchor, "", false, "center");
		if (comment?.action !== "save") return false;
		store.add(selection, comment.text);
	}
	const draft = store.get().at(-1);
	if (!draft) return false;
	ctx.ui.pasteToEditor(tokenInsertion(draft.token));
	return true;
}

/** Center new annotation composers on a one-line selection while preserving its lower edge vertically. */
export function selectionOverlayAnchor(request: SelectionActionRequest): SelectionPoint {
	const row = request.screenAnchor?.row ?? request.screen.end.row;
	const sameRow = request.screen.start.row === request.screen.end.row;
	const start = Math.min(request.screen.start.col, request.screen.end.col);
	const end = Math.max(request.screen.start.col, request.screen.end.col);
	const selectedWidth = sameRow ? visibleWidth(request.text.split("\n", 1)[0] ?? "") : 0;
	const visualEnd = selectedWidth > 0 ? Math.min(end, start + selectedWidth) : end;
	const col = sameRow ? Math.round((start + visualEnd) / 2) : request.screen.start.col;
	return { row, col };
}

export async function editDraft(
	draft: DraftAnnotation,
	anchor: SelectionPoint,
	ctx: ExtensionContext,
	store: AnnotationStore,
	registry: MouseRegistry,
): Promise<boolean> {
	if (!store.find(draft.id)) return false;
	const comment = await showCommentOverlay(ctx, registry, anchor, draft.content, true);
	if (!comment) return false;
	if (comment.action === "delete") {
		const clean = removeTokenAtom(ctx.ui.getEditorText(), draft.token);
		store.remove(draft.id);
		ctx.ui.setEditorText(clean);
		return true;
	}
	store.update(draft.id, comment.text);
	return true;
}

export function annotationDetail(annotation: ResponseAnnotation, index: number): string {
	return `Annotation ${index}\n\nSelected text:\n${annotation.text}\n\n${annotation.annotation}`;
}

export function messageText(message: PiMessageBoundary): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as { role?: PiMessageBoundary; content?: PiMessageBoundary };
	return record.role === "user" ? textContent(record.content) : undefined;
}
