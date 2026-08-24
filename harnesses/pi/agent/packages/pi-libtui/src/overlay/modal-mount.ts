import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { MouseRect, TuiMouseEvent } from "../mouse/events.ts";
import { type MouseRegistry, registerModalPointerShield } from "../mouse/registry.ts";

/** Pointer lifecycle translated into modal-component-local coordinates. */
export interface ModalOverlayMouseEvent {
	type: "enter" | "move" | "leave" | "press" | "release";
	row: number;
	col: number;
	button?: 0 | 1 | 2;
}

/** A modal component that accepts overlay-local keyboard and pointer input. */
export interface ModalOverlayComponent extends Component, Focusable {
	handleInput(data: string): void;
	handleMouse(event: ModalOverlayMouseEvent): boolean;
	dispose?(): void;
}

/** Component wrapper returned to Pi for a mounted modal overlay. */
export interface MountedModalOverlayComponent extends Component, Focusable {
	handleInput(data: string): void;
	dispose(): void;
}

/** Shared host mechanics for a screen-positioned modal component. */
export interface ModalOverlayMountOptions {
	/** Shared registry used by the active Pi pointer bridge. */
	registry: MouseRegistry;
	/** Stable diagnostic identity for the component's pointer region. */
	id: string;
	/** Current screen rectangle occupied by the component. */
	getRect(): MouseRect | undefined;
	/** Current screen rectangle whose selection gestures the modal must block. */
	getShieldRect(): MouseRect | undefined;
	/** Component hit priority; defaults to 10,000. */
	priority?: number;
	/** Shield hit priority; defaults immediately below the component region. */
	shieldPriority?: number;
}

function componentMouseEvent(event: TuiMouseEvent): ModalOverlayMouseEvent | undefined {
	if (
		event.type !== "enter" &&
		event.type !== "move" &&
		event.type !== "leave" &&
		event.type !== "press" &&
		event.type !== "release"
	)
		return undefined;
	return {
		type: event.type,
		row: event.row,
		col: event.col,
		...(event.button === undefined ? {} : { button: event.button }),
	};
}

class MountedModalOverlay implements MountedModalOverlayComponent {
	private readonly removeRegion: () => void;
	private readonly removeShield: () => void;
	private disposed = false;

	constructor(
		private readonly component: ModalOverlayComponent,
		options: ModalOverlayMountOptions,
	) {
		const priority = options.priority ?? 10_000;
		this.removeRegion = options.registry.registerOverlayRegion({
			id: options.id,
			priority,
			getRect: options.getRect,
			onMouse: (event) => {
				const translated = componentMouseEvent(event);
				return translated ? component.handleMouse(translated) : false;
			},
		});
		this.removeShield = registerModalPointerShield(options.registry, {
			id: `${options.id}.shield`,
			priority: options.shieldPriority ?? priority - 1,
			getRect: options.getShieldRect,
		});
	}

	get focused(): boolean {
		return this.component.focused;
	}
	set focused(value: boolean) {
		this.component.focused = value;
	}
	render(width: number): string[] {
		return this.component.render(width);
	}
	invalidate(): void {
		this.component.invalidate();
	}
	handleInput(data: string): void {
		this.component.handleInput(data);
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeRegion();
		this.removeShield();
		this.component.dispose?.();
	}
}

/**
 * Mounts a screen-positioned modal component with local pointer input, a
 * selection shield, and one disposal owner for both registrations.
 */
export function mountModalOverlay(
	component: ModalOverlayComponent,
	options: ModalOverlayMountOptions,
): MountedModalOverlayComponent {
	return new MountedModalOverlay(component, options);
}
