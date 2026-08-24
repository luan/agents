import type { Component } from "@earendil-works/pi-tui";

const pendingCalls = new WeakMap<object, ToolCallPreview>();

/** Provisional call-row ownership shared by Pi tool renderers and replay. */
export class ToolCallPreview implements Component {
	private hidden = false;

	constructor(private readonly component: Component) {}

	render(width: number): string[] {
		return this.hidden ? [] : this.component.render(width);
	}

	invalidate(): void {
		if (!this.hidden) this.component.invalidate();
	}

	hide(): void {
		if (this.hidden) return;
		this.hidden = true;
		(this.component as Component & { dispose?(): void }).dispose?.();
	}

	dispose(): void {
		this.hide();
	}
}

/** Register the row shown before a result exists for this renderer state. */
export function toolCallPreview(state: object, component: Component): ToolCallPreview {
	const preview = new ToolCallPreview(component);
	pendingCalls.get(state)?.hide();
	pendingCalls.set(state, preview);
	return preview;
}

/** Hide a provisional call row before rendering its partial, final, or restored result. */
export function settleToolCallPreview(state: object): void {
	const preview = pendingCalls.get(state);
	if (!preview) return;
	preview.hide();
	pendingCalls.delete(state);
}
