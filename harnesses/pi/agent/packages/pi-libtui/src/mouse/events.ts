export const TEXT_INTERACTION_TARGET = Symbol.for("pi-libtui/mouse/text-interaction-target/v1");

/** Pointer lifecycle events emitted by the shared mouse bridge. */
export type TuiMouseEventType = "press" | "release" | "drag" | "wheel" | "enter" | "move" | "leave";

/** A normalized pointer event delivered to a component or registered overlay region. */
export interface TuiMouseEvent {
	/** Pointer lifecycle phase. */
	type: TuiMouseEventType;
	/** Zero-based row relative to the receiving component or region. */
	row: number;
	/** Zero-based column relative to the receiving component or region. */
	col: number;
	/** Zero-based row in the complete terminal screen. */
	screenRow: number;
	/** Zero-based column in the complete terminal screen. */
	screenCol: number;
	/** Pressed or released button: primary, middle, or secondary. Undefined for hover and wheel events. */
	button: 0 | 1 | 2 | undefined;
	/** Wheel direction, or undefined for non-wheel events. */
	wheel: -1 | 1 | undefined;
	/** Whether Shift was held when the terminal emitted the event. */
	shift: boolean;
	/** Whether Alt was held when the terminal emitted the event. */
	alt: boolean;
	/** Whether Control was held when the terminal emitted the event. */
	ctrl: boolean;
}

/**
 * Opt-in interaction implemented by controls embedded in selectable transcript text.
 *
 * The mouse bridge lets native selection observe pointer presses first, activates
 * the target only when the gesture ends as a click, and offers keyboard input
 * only after higher-priority viewport handlers such as copy mode decline it.
 */
export interface TextInteractionTarget {
	readonly [TEXT_INTERACTION_TARGET]: true;
	/** Synchronize visible keyboard focus owned by the shared viewport bridge. */
	setViewportFocus(focused: boolean): void;
	/** Handle one unclaimed viewport key. Return true only when it was consumed. */
	handleViewportInput(data: string): boolean;
}

/** A terminal-cell rectangle in zero-based screen coordinates. */
export interface MouseRect {
	/** Leftmost screen column. */
	x: number;
	/** Topmost screen row. */
	y: number;
	/** Width in terminal cells. */
	width: number;
	/** Height in terminal rows. */
	height: number;
}
