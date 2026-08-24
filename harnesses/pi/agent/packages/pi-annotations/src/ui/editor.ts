import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	cursorStyle,
	isNativeCursorStyle,
	markEditorCursor,
	markSemanticCursorPosition,
	PointerInteractionController,
	renderEditorPasteMarkerPills,
	renderEditorTokenPills,
} from "pi-libtui";
import { SemanticEditor } from "pi-libtui/editor";
import type { MouseRect, TuiMouseEvent } from "pi-libtui/mouse";
import { composerPillContent } from "../core/pills.ts";
import type { AnnotationStore } from "../core/store.ts";
import { removeTokenAtom } from "../core/store.ts";
import { renderPill } from "./pills.ts";

interface TokenHit {
	draftId: string;
	x: number;
	y: number;
	width: number;
}
interface ScreenTokenHit {
	draftId: string;
	rect: MouseRect;
}
export type ComposerHoverListener = (draftId: string | undefined, anchor?: { row: number; col: number }) => void;
export type ComposerActivateListener = (draftId: string, anchor: { row: number; col: number }) => void;

export class AnnotationEditor extends SemanticEditor {
	private tokenHits: TokenHit[] = [];
	private readonly interaction = new PointerInteractionController<ScreenTokenHit>({
		key: (hit) => hit.draftId,
		rect: (hit) => hit.rect,
	});

	constructor(
		tui: TUI,
		private readonly semanticTheme: Theme,
		private readonly appKeys: KeybindingsManager,
		private readonly store: AnnotationStore,
		private readonly onHover?: ComposerHoverListener,
		private readonly onActivate?: ComposerActivateListener,
	) {
		super(tui, semanticTheme, appKeys);
	}

	override handleInput(data: string): void {
		const submitting = this.appKeys.matches(data, "tui.input.submit");
		const before = this.getText();
		const beforeDrafts = [...this.store.get()];
		super.handleInput(data);
		// Pi clears the editor synchronously before its accepted input reaches the
		// extension hook. Keep drafts alive across that transition; message_start
		// is the commit point that clears them.
		if (!submitting) {
			let after = this.getText();
			const removed = beforeDrafts.find((draft) => before.includes(draft.token) && !after.includes(draft.token));
			if (removed) {
				after = removeTokenAtom(before, removed.token);
				super.setText(after);
			}
			this.store.retainTokens(after);
		}
	}

	override setText(text: string): void {
		super.setText(text);
		this.store.retainTokens(text);
	}

	override render(width: number): string[] {
		const pastePills = renderEditorPasteMarkerPills(super.render(width), width, this.semanticTheme);
		const drafts = this.store.get();
		const tokenOwners = new Map(drafts.map((draft) => [draft.token, draft.id]));
		const rendered = renderEditorTokenPills(
			pastePills.lines,
			width,
			this.semanticTheme,
			drafts.map((draft) => ({
				token: draft.token,
				...composerPillContent(draft),
				render: ({ content, destinationBackgroundAnsi, inverse }) =>
					renderPill(this.semanticTheme, content, {
						surface: "base",
						state:
							inverse && !isNativeCursorStyle(cursorStyle("insertion"))
								? "cursor"
								: this.interaction.hoveredTarget()?.draftId === draft.id
									? "hover"
									: "normal",
						surroundingBackgroundAnsi: destinationBackgroundAnsi,
					}),
			})),
		);
		this.tokenHits = rendered.pills.flatMap((pill) => {
			const draftId = tokenOwners.get(pill.token);
			return draftId ? [{ draftId, x: pill.x, y: pill.line, width: pill.width }] : [];
		});
		const lines = rendered.lines;
		return lines.map((line) =>
			markSemanticCursorPosition(markEditorCursor(line, { theme: this.semanticTheme, role: "insertion" }), "insertion"),
		);
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type !== "leave") {
			const screenOrigin = { row: event.screenRow - event.row, col: event.screenCol - event.col };
			this.interaction.setTargets(
				this.tokenHits.map((hit) => ({
					draftId: hit.draftId,
					rect: { x: screenOrigin.col + hit.x, y: screenOrigin.row + hit.y, width: hit.width, height: 1 },
				})),
			);
		}
		return this.interaction.handleMouse(event, {
			onHoverChange: (hit) => {
				this.onHover?.(hit?.draftId, hit ? tokenAnchor(hit) : undefined);
				this.tui.requestRender();
			},
			onActivate: (hit) => this.onActivate?.(hit.draftId, tokenAnchor(hit)),
		});
	}

	getTokenHits(): readonly TokenHit[] {
		return this.tokenHits.map((hit) => ({ ...hit }));
	}
}

function tokenAnchor(hit: ScreenTokenHit): { row: number; col: number } {
	return { row: hit.rect.y, col: hit.rect.x };
}
