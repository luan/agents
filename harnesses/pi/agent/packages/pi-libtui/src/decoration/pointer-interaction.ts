import type { MouseRect, TuiMouseEvent } from "../mouse/events.ts";

/**
 * Domain-owned screen target used by {@link PointerInteractionController}.
 * Rendering and identity stay with the caller; this contract only supplies
 * the stable key and hit rectangle needed for pointer state.
 */
export interface PointerInteractionOptions<Target> {
	key(target: Target): string;
	rect(target: Target): MouseRect;
}

/** Hover and click callbacks for a screen-positioned pointer controller. */
export interface PointerInteractionHandlers<Target> {
	onHoverChange?(target: Target | undefined): void;
	onActivate?(target: Target): void;
}

/**
 * Shared pointer lifecycle for screen decorations.
 *
 * Feature packages own target meaning, rendering, and activation. This class
 * owns only hit testing, hover state, primary-button capture, and bounds.
 * Keeping that state in one place prevents pills, markers, and other inline
 * decorations from growing subtly different click/hover implementations.
 */
export class PointerInteractionController<Target> {
	private targets: Target[] = [];
	private hoveredKey: string | undefined;
	private pressedTarget: Target | undefined;

	constructor(private readonly options: PointerInteractionOptions<Target>) {}

	/** Replace the current visible targets after a screen decoration render. */
	setTargets(targets: readonly Target[]): void {
		this.targets = [...targets];
		if (this.hoveredKey !== undefined && !this.findByKey(this.hoveredKey)) this.hoveredKey = undefined;
		if (this.pressedTarget !== undefined && !this.findByKey(this.options.key(this.pressedTarget))) {
			this.pressedTarget = undefined;
		}
	}

	/** Find the visible target containing an absolute terminal cell. */
	targetAt(screenCol: number, screenRow: number): Target | undefined {
		return this.targets.find((target) => contains(this.options.rect(target), screenCol, screenRow));
	}

	/** Return the currently hovered visible target, if any. */
	hoveredTarget(): Target | undefined {
		return this.hoveredKey === undefined ? undefined : this.findByKey(this.hoveredKey);
	}

	/** Change hover state and report whether the stable target changed. */
	setHover(target: Target | undefined): boolean {
		const next = target === undefined ? undefined : this.options.key(target);
		if (this.hoveredKey === next) return false;
		this.hoveredKey = next;
		return true;
	}

	/** Return the union bounds of all currently visible targets. */
	getBounds(): MouseRect | undefined {
		if (this.targets.length === 0) return undefined;
		const rects = this.targets.map((target) => this.options.rect(target));
		const left = Math.min(...rects.map((rect) => rect.x));
		const top = Math.min(...rects.map((rect) => rect.y));
		const right = Math.max(...rects.map((rect) => rect.x + rect.width));
		const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	/**
	 * Handle one normalized pointer event in absolute screen coordinates.
	 * Primary-button release activates only the target that received the press.
	 */
	handleMouse(event: TuiMouseEvent, handlers: PointerInteractionHandlers<Target> = {}): boolean {
		if (event.type === "leave") {
			this.pressedTarget = undefined;
			if (this.setHover(undefined)) handlers.onHoverChange?.(undefined);
			return false;
		}

		const target = this.targetAt(event.screenCol, event.screenRow);
		if (event.type === "enter" || event.type === "move") {
			if (this.setHover(target)) handlers.onHoverChange?.(target);
			return target !== undefined;
		}

		if (event.type === "press") {
			if (event.button !== undefined && event.button !== 0) return false;
			this.pressedTarget = target;
			return target !== undefined;
		}

		if (event.type === "release") {
			if (event.button !== undefined && event.button !== 0) return false;
			const pressedTarget = this.pressedTarget;
			this.pressedTarget = undefined;
			if (pressedTarget === undefined) return target !== undefined;
			if (target !== undefined && this.options.key(target) === this.options.key(pressedTarget)) {
				handlers.onActivate?.(pressedTarget);
			}
			return true;
		}

		return target !== undefined;
	}

	/** Clear all targets and transient pointer state. */
	clear(): void {
		this.targets = [];
		this.hoveredKey = undefined;
		this.pressedTarget = undefined;
	}

	private findByKey(key: string): Target | undefined {
		return this.targets.find((target) => this.options.key(target) === key);
	}
}

function contains(rect: MouseRect, col: number, row: number): boolean {
	return col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height;
}
