import type { Component } from "@earendil-works/pi-tui";
import { loadedDiffHighlighter, whenSyntaxReady } from "../syntax.ts";
import type { UnifiedDiffModel } from "./model.ts";
import { type RenderUnifiedDiffOptions, renderUnifiedDiff, type UnifiedDiffViewport } from "./render.ts";

export interface UnifiedDiffViewOptions extends Omit<RenderUnifiedDiffOptions, "width"> {
	readonly model: UnifiedDiffModel;
	readonly requestRender?: () => void;
}

/** Small Pi component wrapper around the pure cached renderer. */
export class UnifiedDiffView implements Component {
	private options: UnifiedDiffViewOptions;
	private renderedSource: readonly string[] | undefined;
	private renderedLines: string[] | undefined;
	private omissionRow: number | undefined;
	private omissionRowHovered = false;
	private syntaxReadyRequested = false;

	constructor(options: UnifiedDiffViewOptions) {
		this.options = options;
		this.omissionRow = undefined;
	}

	setModel(model: UnifiedDiffModel): void {
		this.options = { ...this.options, model };
		this.invalidate();
	}

	getOmissionRow(): number | undefined {
		return this.omissionRow;
	}

	setOmissionRowHovered(hovered: boolean): void {
		if (this.omissionRowHovered === hovered) return;
		this.omissionRowHovered = hovered;
		this.invalidate();
	}

	setViewport(viewport: UnifiedDiffViewport): void {
		this.options = { ...this.options, viewport };
		this.invalidate();
	}

	render(width: number): string[] {
		this.requestSyntaxReady();
		const result = renderUnifiedDiff(this.options.model, {
			...this.options,
			width,
			omissionRowHovered: this.omissionRowHovered,
		});
		const source = result.lines;
		this.omissionRow = result.omissionRow;
		if (source !== this.renderedSource) {
			this.renderedSource = source;
			this.renderedLines = [...source];
		}
		return this.renderedLines ?? [];
	}

	invalidate(): void {
		this.renderedSource = undefined;
		this.renderedLines = undefined;
		this.omissionRow = undefined;
	}

	private requestSyntaxReady(): void {
		if (this.syntaxReadyRequested || loadedDiffHighlighter() || !this.options.requestRender) return;
		this.syntaxReadyRequested = true;
		whenSyntaxReady(() => {
			this.invalidate();
			this.options.requestRender?.();
		});
	}
}
