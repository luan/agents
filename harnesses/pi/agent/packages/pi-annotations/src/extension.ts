import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { removeUnmarkedEditorCursor, subscribeTuiAppearance } from "pi-libtui";
import { ensureMouseRegistry } from "pi-libtui/mouse";
import { ensureSelectionRegistry, type SelectionActionRequest } from "pi-libtui/selection";
import { registerAnnotationSettings } from "./config/settings.ts";
import {
	ANNOTATION_SYSTEM_GUIDANCE,
	hasDeveloperPromptHost,
	registerAnnotationDeveloperPrompt,
} from "./contributions/developer-prompt.ts";
import { parseEnvelope, serializeEnvelope } from "./core/envelope.ts";
import { composerPillContent, plainPill, responsePillContent } from "./core/pills.ts";
import { AnnotationPresentationGroups } from "./core/presentation.ts";
import { AnnotationStore } from "./core/store.ts";
import type { DraftAnnotation } from "./core/types.ts";
import { composeAnnotation, editDraft, messageText } from "./runtime/annotations.ts";
import { renderAnnotationMarker } from "./ui/annotation-markers.ts";
import { AnnotationEditor } from "./ui/editor.ts";
import { handleReferencePillMouse, ReferencePillController } from "./ui/reference-pills.ts";
import {
	AnnotationMarkerController,
	decorateAnnotationDetail,
	shouldDecorateAnnotationMarkers,
} from "./ui/screen-markers.ts";

const STATUS_KEY = "pi-annotations.drafts";
const WIDGET_KEY = "pi-annotations.render-host";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function status(drafts: readonly DraftAnnotation[]): string | undefined {
	if (drafts.length === 0) return undefined;
	return `${drafts.length} annotation${drafts.length === 1 ? "" : "s"} to send`;
}

export default function annotationExtension(pi: ExtensionAPI): void {
	const store = new AnnotationStore();
	const registry = ensureMouseRegistry();
	const selection = ensureSelectionRegistry();
	const markers = new AnnotationMarkerController();
	const references = new ReferencePillController();
	let pendingSubmittedText: string | undefined;
	const presentation = new AnnotationPresentationGroups();
	let overlayActive = false;
	let removeRequest: (() => void) | undefined;
	let removeReferenceCleanupDecorator: (() => void) | undefined;
	let removeDecorator: (() => void) | undefined;
	let removeMarkerRegion: (() => void) | undefined;
	let removeReferenceRegion: (() => void) | undefined;
	let removeStoreListener: (() => void) | undefined;
	let installedEditorFactory: EditorFactory | undefined;
	let requestRender = (): void => {};
	let composerHover: { draftId: string; anchor: { row: number; col: number } } | undefined;
	const unregisterSettings = registerAnnotationSettings();
	const unregisterDeveloperPrompt = registerAnnotationDeveloperPrompt();
	const setOverlayActive = (active: boolean): void => {
		overlayActive = active;
		if (active) {
			markers.clear();
			references.clear();
			composerHover = undefined;
		}
		requestRender();
	};

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "user") {
			return presentation.projectUser(
				markdown,
				(annotation, index) =>
					renderAnnotationMarker(
						plainPill(responsePillContent(annotation, index)),
						presentation.referenceUrl(index, "user"),
					),
				(annotation, index, url) => renderAnnotationMarker(plainPill(responsePillContent(annotation, index)), url),
			);
		}
		if (context.messageType !== "assistant-thinking")
			return presentation.projectAssistant(markdown, (annotation, index, url) =>
				renderAnnotationMarker(plainPill(responsePillContent(annotation, index)), url),
			);
		return markdown;
	});

	pi.on("session_start", (_event, sessionCtx) => {
		pendingSubmittedText = undefined;
		presentation.clear();
		store.clear();
		if (sessionCtx.mode === "tui") {
			sessionCtx.ui.setWidget(WIDGET_KEY, (tui) => {
				requestRender = () => tui.requestRender();
				const removeAppearanceSubscription = subscribeTuiAppearance(() => tui.requestRender());
				return {
					render: () => [],
					invalidate() {},
					dispose() {
						removeAppearanceSubscription();
						requestRender = (): void => {};
					},
				};
			});
			// The widget factory is invoked by Pi during composition; the editor
			// factory below provides the same render hook as soon as it is created.
		}
		if (sessionCtx.mode === "tui" && !sessionCtx.ui.getEditorComponent()) {
			installedEditorFactory = (tui, _editorTheme, keybindings) => {
				requestRender = () => tui.requestRender();
				return new AnnotationEditor(
					tui,
					sessionCtx.ui.theme,
					keybindings,
					store,
					(draftId, anchor) => {
						composerHover = draftId && anchor ? { draftId, anchor } : undefined;
						requestRender();
					},
					(draftId, anchor) => {
						if (overlayActive) return;
						const draft = store.find(draftId);
						if (!draft) return;
						setOverlayActive(true);
						void editDraft(draft, anchor, sessionCtx, store, registry).finally(() => setOverlayActive(false));
					},
				);
			};
			sessionCtx.ui.setEditorComponent(installedEditorFactory);
		}
		removeStoreListener?.();
		removeStoreListener = store.onChange((drafts) => {
			sessionCtx.ui.setStatus(STATUS_KEY, status(drafts));
			requestRender();
		});
		removeRequest?.();
		removeRequest = selection.onSelectionAction(async (request: SelectionActionRequest) => {
			if (request.action !== "selection.comment" && request.action !== "selection.reaction") return false;
			if (overlayActive) return false;
			setOverlayActive(true);
			try {
				return await composeAnnotation(request, sessionCtx, store, registry);
			} finally {
				setOverlayActive(false);
			}
		});
		removeReferenceCleanupDecorator?.();
		removeReferenceCleanupDecorator = registry.registerScreenDecorator({
			id: "pi-annotations.selection-marker-cleanup",
			// Remove inert APC wrappers before any later decorator can insert
			// styling or cursor cells inside the wrapper. Those control sequences
			// are identity metadata, never part of the rendered screen.
			priority: 500,
			decorate: (screen, context) => {
				if (context.hasOverlay) references.clear();
				// Pi applies screen decorators to the transcript and the overlay
				// together. The overlay suppresses later annotation decoration,
				// but the transcript's APC wrappers still must not reach the
				// terminal renderer.
				const cleaned = references.prepareSelection(screen);
				return context.hasOverlay ? cleaned.map(removeUnmarkedEditorCursor) : cleaned;
			},
		});
		removeDecorator?.();
		removeDecorator = registry.registerScreenDecorator({
			id: "pi-annotations.draft-markers",
			// Higher priorities run first. Rebuild pills after copy-mode's cursor
			// decorator so cursor paint cannot leak through their rounded caps.
			priority: 5,
			decorate: (screen, context) => {
				if (!shouldDecorateAnnotationMarkers(overlayActive, context.hasOverlay)) {
					markers.clear();
					// Reference badges belong to the transcript and must be rebuilt
					// after Pi paints its overlay/selection colors. Draft handles and
					// their hover cards remain suppressed while an overlay is open.
					return references.decorate(
						screen,
						context.width,
						sessionCtx.ui.theme,
						(url) => presentation.resolve(url),
						context.selectionActive === true,
						context.transcriptLines,
						context.viewport,
					);
				}
				const decorated = markers.decorate(
					screen,
					store.get(),
					context.width,
					sessionCtx.ui.theme,
					context.viewport,
					context.transcriptLines,
				);
				const hoveredDraft = composerHover ? store.find(composerHover.draftId) : undefined;
				const composerAnchorVisible =
					hoveredDraft !== undefined &&
					composerHover !== undefined &&
					composerPillVisible(screen, hoveredDraft, composerHover.anchor);
				if (!composerAnchorVisible && composerHover) composerHover = undefined;
				const withComposerDetail =
					hoveredDraft && composerHover && composerAnchorVisible
						? decorateAnnotationDetail(
								decorated,
								hoveredDraft,
								composerHover.anchor,
								context.width,
								sessionCtx.ui.theme,
							)
						: decorated;
				return references.decorate(
					withComposerDetail,
					context.width,
					sessionCtx.ui.theme,
					(url) => presentation.resolve(url),
					context.selectionActive === true,
					context.transcriptLines,
					context.viewport,
				);
			},
		});
		removeMarkerRegion?.();
		removeMarkerRegion = registry.registerOverlayRegion({
			id: "pi-annotations.transcript-handles",
			priority: 5_000,
			getRect: () => markers.getBounds(),
			onMouse(event) {
				return markers.handleMouse(event, requestRender, (hit) => {
					const draft = store.find(hit.draftId);
					if (!draft || overlayActive) return;
					setOverlayActive(true);
					void editDraft(
						draft,
						{ row: hit.rect.y, col: hit.rect.x + hit.rect.width },
						sessionCtx,
						store,
						registry,
					).finally(() => setOverlayActive(false));
				});
			},
		});
		removeReferenceRegion?.();
		removeReferenceRegion = registry.registerOverlayRegion({
			id: "pi-annotations.reference-hover",
			priority: 4_000,
			getRect: () => references.getBounds(),
			onMouse: (event) => handleReferencePillMouse(references, event, requestRender),
		});
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (store.get().length === 0) return { action: "continue" };
		store.retainTokens(event.text);
		const drafts = store.get();
		if (drafts.length === 0) return { action: "continue" };
		if (!drafts.every((draft) => event.text.includes(draft.token))) return { action: "continue" };
		const transformed = serializeEnvelope(drafts, store.ordinaryText(event.text));
		pendingSubmittedText = transformed;
		return {
			action: "transform",
			text: transformed,
			...(event.images ? { images: event.images } : {}),
		};
	});

	pi.on("before_agent_start", (event) => {
		if (!parseEnvelope(event.prompt)) return;
		if (hasDeveloperPromptHost()) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ANNOTATION_SYSTEM_GUIDANCE}`,
		};
	});

	pi.on("message_start", (event) => {
		if (!pendingSubmittedText) return;
		if (messageText(event.message) !== pendingSubmittedText) return;
		pendingSubmittedText = undefined;
		store.clear();
	});

	pi.on("session_shutdown", (event, sessionCtx) => {
		removeRequest?.();
		removeRequest = undefined;
		removeReferenceCleanupDecorator?.();
		removeReferenceCleanupDecorator = undefined;
		removeDecorator?.();
		removeDecorator = undefined;
		removeMarkerRegion?.();
		removeMarkerRegion = undefined;
		removeReferenceRegion?.();
		removeReferenceRegion = undefined;
		markers.clear();
		references.clear();
		composerHover = undefined;
		removeStoreListener?.();
		removeStoreListener = undefined;
		if (installedEditorFactory && sessionCtx.ui.getEditorComponent() === installedEditorFactory) {
			// Pi transfers the current text when restoring its default editor. Strip
			// our private atoms while their owning drafts are still available.
			sessionCtx.ui.setEditorText(store.ordinaryText(sessionCtx.ui.getEditorText()));
			store.clear();
			sessionCtx.ui.setEditorComponent(undefined);
		} else {
			store.clear();
		}
		sessionCtx.ui.setStatus(STATUS_KEY, undefined);
		if (sessionCtx.mode === "tui") sessionCtx.ui.setWidget(WIDGET_KEY, undefined);
		installedEditorFactory = undefined;
		if (event.reason === "reload" || event.reason === "quit") {
			unregisterDeveloperPrompt();
			unregisterSettings();
		}
	});
}

function composerPillVisible(
	screen: readonly string[],
	draft: DraftAnnotation,
	anchor: { row: number; col: number },
): boolean {
	const row = screen[anchor.row];
	if (row === undefined) return false;
	const pill = plainPill(composerPillContent(draft));
	return (
		stripTerminalSequences(sliceByColumn(row, anchor.col, visibleWidth(pill), true)) === stripTerminalSequences(pill)
	);
}
