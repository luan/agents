import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { ComponentStack, type ComponentStackSpan } from "../component-stack.ts";
import { FOLD_TARGET_AT_ROW, type FoldTarget, type FoldTargetAtRow, foldTargetAt } from "../folding.ts";
import { TEXT_INTERACTION_TARGET, type TextInteractionTarget, type TuiMouseEvent } from "../mouse.ts";
import { ToolAction, type ToolActionView } from "./action.ts";

export interface ToolTranscriptOptions {
	theme: Theme;
	view?: ToolActionView;
	action?: Component;
	body?: readonly Component[];
	maxRows?: number;
	/** Columns of leading whitespace added to every payload row. */
	bodyIndent?: number;
}

/**
 * A copy-friendly tool transcript: one action sentence followed by its payload.
 * Payload components render at the caller's width minus `bodyIndent`; the
 * transcript does not impose a background.
 */
export class ToolTranscript implements Component {
	private readonly stack: ComponentStack;
	private readonly maxRows: number | undefined;
	private readonly bodyIndent: number;
	private bodies: TranscriptBody[];

	constructor(options: ToolTranscriptOptions) {
		const action =
			options.action ?? (options.view ? new ToolAction({ theme: options.theme, view: options.view }) : undefined);
		if (!action) throw new Error("ToolTranscript requires an action or view");
		this.bodyIndent = Math.max(0, Math.floor(options.bodyIndent ?? 0));
		this.bodies = (options.body ?? []).map((component) => new TranscriptBody(component, this.bodyIndent));
		this.maxRows = normalizedRows(options.maxRows);
		this.stack = new ComponentStack([action, ...this.bodies], { maxHeight: this.maxRows });
	}

	/** Replace payload components while retaining wrappers for stable component identities. */
	setBody(components: readonly Component[]): void {
		const available = [...this.bodies];
		this.bodies = components.map((component) => {
			const existingIndex = available.findIndex((body) => body.wraps(component));
			return existingIndex < 0
				? new TranscriptBody(component, this.bodyIndent)
				: available.splice(existingIndex, 1)[0]!;
		});
		for (const body of available) body.dispose();
		this.stack.setChildren([this.stack.getChildren()[0]!, ...this.bodies]);
	}

	render(width: number): string[] {
		return this.stack.render(width);
	}

	handleViewportInput(data: string): boolean {
		return this.stack.handleViewportInput(data);
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.stack.onMouse(event);
	}

	get children(): readonly Component[] {
		return this.stack.getChildren();
	}

	getSpans(): readonly ComponentStackSpan[] {
		const spans = this.stack.getSpans();
		if (this.maxRows === undefined) return spans;
		return spans
			.filter((span) => span.row < this.maxRows!)
			.map((span) => ({ ...span, height: Math.min(span.height, this.maxRows! - span.row) }));
	}

	invalidate(): void {
		this.stack.invalidate();
	}

	dispose(): void {
		for (const component of new Set(this.stack.getChildren()))
			(component as Component & { dispose?(): void }).dispose?.();
	}
}

/** Structural payload wrapper that indents rows and preserves nested viewport and fold contracts. */
class TranscriptBody implements Component, TextInteractionTarget, FoldTargetAtRow {
	readonly [TEXT_INTERACTION_TARGET] = true as const;
	private readonly gutter: string;
	private width = 0;
	private height = 0;

	constructor(
		private component: Component,
		private readonly indent: number,
	) {
		this.gutter = " ".repeat(indent);
	}

	wraps(component: Component): boolean {
		return this.component === component;
	}

	render(width: number): string[] {
		const inner = Math.max(0, Math.floor(width) - this.indent);
		this.width = inner;
		const lines = inner === 0 ? [] : this.component.render(inner);
		this.height = lines.length;
		return this.indent === 0 ? lines : lines.map((line) => `${this.gutter}${line}`);
	}

	getSpans() {
		return [{ component: this.component, row: 0, col: this.indent, width: this.width, height: this.height }];
	}

	invalidate(): void {
		this.component.invalidate();
	}

	dispose(): void {
		(this.component as Component & { dispose?(): void }).dispose?.();
	}

	setViewportFocus(focused: boolean): void {
		this.interactive()?.setViewportFocus?.(focused);
	}

	isViewportFocused(): boolean {
		return this.interactive()?.isViewportFocused?.() ?? false;
	}

	handleViewportInput(data: string): boolean {
		return this.interactive()?.handleViewportInput?.(data) ?? false;
	}

	onMouse(event: TuiMouseEvent): boolean {
		return this.interactive()?.onMouse?.({ ...event, col: event.col - this.indent }) ?? false;
	}

	[FOLD_TARGET_AT_ROW](row: number): FoldTarget | undefined {
		return foldTargetAt(this.component, row);
	}

	private interactive() {
		return this.component as Component & {
			setViewportFocus?(focused: boolean): void;
			isViewportFocused?(): boolean;
			handleViewportInput?(data: string): boolean;
			onMouse?(event: TuiMouseEvent): boolean;
		};
	}
}

function normalizedRows(rows: number | undefined): number | undefined {
	if (rows === undefined || !Number.isFinite(rows)) return undefined;
	return Math.max(0, Math.floor(rows));
}
