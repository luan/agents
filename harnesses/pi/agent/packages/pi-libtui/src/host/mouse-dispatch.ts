import { type Component, matchesKey, type TUI, type TuiInputListenerResult } from "@earendil-works/pi-tui";
import { getMouseRegistryState } from "../mouse/registry.ts";
import type { MouseRegistry, TextInteractionTarget, TuiMouseEventType } from "../mouse.ts";
import { publishFullscreenLayoutCapability } from "../mouse.ts";
import { ensureSelectionRegistry } from "../selection.ts";
import { createEvent, isPrimarySelectionRelease, type ParsedMouseEvent, parseMouse } from "./mouse-input.ts";
import { type MouseTarget, targetsAt as resolveTargetsAt } from "./mouse-targets.ts";
import {
	contains,
	isRecord,
	isVisibleComponent,
	rendererHasOverlay,
	rendererLayoutFrame,
} from "./pi-layout-adapter.ts";
import { fullscreenLayoutCapability, nativeSelectionCompleted } from "./pi-native-selection.ts";

const INSTALLATION_KEY = Symbol.for("pi-libtui/mouse/bridge-installation/v1");
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

// type-boundary: Pi 0.84.2's private input and overlay members are narrowed by the validators below.
type PiPrivateValue = unknown;

type ViewportInputHandler = (this: object, data: string) => TuiInputListenerResult;

interface BridgeInstallation {
	protocol: "pi-libtui/mouse/bridge-installation/v1";
	refs: number;
	patched: ViewportInputHandler;
	dispose(): void;
}

interface PointerState {
	capture?: MouseTarget;
	hover?: MouseTarget;
	lastPointer?: ParsedMouseEvent;
	textClick?: { target: MouseTarget; x: number; y: number; moved: boolean };
	nativePrimaryPress?: boolean;
	keyboardTarget?: Component & TextInteractionTarget;
}

function setKeyboardTarget(state: PointerState, target: (Component & TextInteractionTarget) | undefined): void {
	if (state.keyboardTarget === target) return;
	try {
		state.keyboardTarget?.setViewportFocus(false);
	} catch {
		// Optional transcript interaction must not break the renderer input path.
	}
	state.keyboardTarget = target;
	try {
		target?.setViewportFocus(true);
	} catch {
		state.keyboardTarget = undefined;
	}
}

function isInstallation(value: PiPrivateValue): value is BridgeInstallation {
	if (!isRecord(value)) return false;
	return (
		value.protocol === "pi-libtui/mouse/bridge-installation/v1" &&
		typeof value.refs === "number" &&
		typeof value.patched === "function" &&
		typeof value.dispose === "function"
	);
}

function withNativeCopyDeferred(renderer: object, invoke: () => TuiInputListenerResult): TuiInputListenerResult {
	const property = "copySelectionToClipboard";
	const ownDescriptor = Reflect.getOwnPropertyDescriptor(renderer, property);
	const suppress = (): Promise<void> => Promise.resolve();
	if (!Reflect.set(renderer, property, suppress) || Reflect.get(renderer, property) !== suppress) return invoke();
	try {
		return invoke();
	} finally {
		if (Reflect.get(renderer, property) === suppress) {
			if (ownDescriptor) Reflect.defineProperty(renderer, property, ownDescriptor);
			else Reflect.deleteProperty(renderer, property);
		}
	}
}

function requestRender(renderer: object): void {
	try {
		const method = Reflect.get(renderer, "requestRender") as PiPrivateValue;
		if (typeof method === "function") Reflect.apply(method, renderer, []);
	} catch {
		// A component callback must not break Pi's input path during renderer replacement.
	}
}

function nativePointerOwnsInput(renderer: object): boolean {
	return Reflect.get(renderer, "selectionPressActive") === true || Boolean(Reflect.get(renderer, "scrollbarDrag"));
}

function defersInputToOverlay(renderer: object): boolean {
	const method = Reflect.get(renderer, "shouldDeferViewportInputToOverlay") as PiPrivateValue;
	if (typeof method !== "function") return false;
	try {
		return Reflect.apply(method, renderer, []) === true;
	} catch {
		return false;
	}
}

/** Patch Pi's fullscreen input path until the official API also covers overlays, capture, and hover. */
export function installMouseDispatch(tui: TUI, prototype: object, registry: MouseRegistry): () => void {
	const finish = (removeBridge: () => void): (() => void) => {
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			removeBridge();
		};
	};
	const existing = Reflect.get(prototype, INSTALLATION_KEY) as PiPrivateValue;
	if (isInstallation(existing)) {
		existing.refs += 1;
		let disposed = false;
		return finish(() => {
			if (disposed) return;
			disposed = true;
			existing.refs -= 1;
			if (existing.refs === 0) existing.dispose();
		});
	}

	const originalValue = Reflect.get(prototype, "handleViewportInput") as PiPrivateValue;
	if (typeof originalValue !== "function") return finish(() => {});
	const original = originalValue as ViewportInputHandler;
	const removeFullscreenLayoutCapability = publishFullscreenLayoutCapability(fullscreenLayoutCapability);
	const registryState = getMouseRegistryState(registry);
	const rendererForViewport = tui as object;
	const preserveViewport = (): void => {
		const frame = rendererLayoutFrame(rendererForViewport);
		const scrollView = frame?.primaryScrollView;
		if (!scrollView) return;
		try {
			scrollView.scrollTo(scrollView.scrollTop, { disableFollow: true });
		} catch {
			// The native viewport is optional across Pi versions.
		}
	};
	registryState.viewportPreserver = preserveViewport;
	const states = new Map<object, PointerState>();
	const targetsAt = (renderer: object, x: number, y: number, includeLayout: boolean): MouseTarget[] =>
		resolveTargetsAt(registry, renderer, x, y, includeLayout, defersInputToOverlay);

	const send = (target: MouseTarget, type: TuiMouseEventType, parsed: ParsedMouseEvent): boolean => {
		const rect = target.getRect();
		if (!rect) return false;
		return target.dispatch(createEvent(type, parsed, rect));
	};
	const containsTarget = (target: MouseTarget, parsed: ParsedMouseEvent): boolean => {
		if (target.isCurrent && !target.isCurrent()) return false;
		if (target.containsPoint) return target.containsPoint(parsed.x, parsed.y);
		const rect = target.getRect();
		return Boolean(rect && contains(rect, parsed.x, parsed.y));
	};
	const finishTextClick = (
		renderer: object,
		state: PointerState,
		parsed: ParsedMouseEvent,
		dispatchRelease: boolean,
	): void => {
		const textClick = state.textClick;
		if (!textClick) return;
		const isClick = !textClick.moved && parsed.x === textClick.x && parsed.y === textClick.y;
		// Resolve the release against the current frame. A press can invalidate and
		// rerender a disclosure before its release arrives; dispatching through the
		// captured box would let that stale geometry collapse a different surface.
		const currentTarget = targetsAt(renderer, parsed.x, parsed.y, true).find(
			(target) => target.key === textClick.target.key && containsTarget(target, parsed),
		);
		const handled = dispatchRelease
			? Boolean(currentTarget && send(currentTarget, "release", parsed))
			: Boolean(isClick && currentTarget);
		if (isClick && handled && currentTarget?.textInteraction) {
			setKeyboardTarget(state, currentTarget.textInteraction);
		}
		state.textClick = undefined;
	};
	const cancelTextClick = (state: PointerState, parsed: ParsedMouseEvent | undefined): void => {
		if (!state.textClick) return;
		if (parsed) send(state.textClick.target, "release", { ...parsed, rawButton: 3 });
		state.textClick = undefined;
	};

	const patched: ViewportInputHandler = function (data) {
		let state = states.get(this);
		if (!state) {
			state = {};
			states.set(this, state);
		}
		const mouseInput = parseMouse(data);
		if (mouseInput.kind !== "event") {
			if (data === FOCUS_OUT) {
				const lastPointer = state.lastPointer;
				const hadPointerState = Boolean(state.capture || state.hover || state.textClick);
				if (lastPointer) {
					if (state.capture) send(state.capture, "release", { ...lastPointer, rawButton: 3 });
					if (state.hover) send(state.hover, "leave", lastPointer);
				}
				cancelTextClick(state, lastPointer);
				state.capture = undefined;
				state.hover = undefined;
				state.lastPointer = undefined;
				state.nativePrimaryPress = undefined;
				setKeyboardTarget(state, undefined);
				if (hadPointerState) requestRender(this);
			}
			if (data === FOCUS_IN || data === FOCUS_OUT || mouseInput.kind === "unsupported") {
				return Reflect.apply(original, this, [data]);
			}
			const viewportInput = registry.dispatchViewportInput(data);
			if (viewportInput.consumed) return { consume: true, data: viewportInput.data };
			if (rendererHasOverlay(this) || defersInputToOverlay(this)) {
				setKeyboardTarget(state, undefined);
				return Reflect.apply(original, this, [viewportInput.data]);
			}
			if (matchesKey(viewportInput.data, "escape")) {
				setKeyboardTarget(state, undefined);
				requestRender(this);
				return Reflect.apply(original, this, [viewportInput.data]);
			}
			const keyboardTarget = state.keyboardTarget;
			if (keyboardTarget) {
				const frame = rendererLayoutFrame(this);
				if (!frame || !isVisibleComponent(frame, keyboardTarget)) {
					setKeyboardTarget(state, undefined);
				} else {
					try {
						if (keyboardTarget.handleViewportInput(viewportInput.data)) {
							requestRender(this);
							return { consume: true, data: viewportInput.data };
						}
					} catch {
						setKeyboardTarget(state, undefined);
					}
				}
			}
			return Reflect.apply(original, this, [viewportInput.data]);
		}
		const parsed = mouseInput.event;
		state.lastPointer = parsed;
		if (parsed.type === "press" && defersInputToOverlay(this)) setKeyboardTarget(state, undefined);
		if (!state.capture && nativePointerOwnsInput(this)) {
			const textClick = state.textClick;
			if (textClick && parsed.type === "drag") {
				textClick.moved ||= parsed.x !== textClick.x || parsed.y !== textClick.y;
				if (textClick.moved) send(textClick.target, "drag", parsed);
			}
			const selectionWasActive = parsed.type === "release" && Reflect.get(this, "selectionPressActive") === true;
			const deferCopy = selectionWasActive && isPrimarySelectionRelease(parsed) && registry.shouldDeferNativeCopy();
			const invokeOriginal = (): TuiInputListenerResult => Reflect.apply(original, this, [data]);
			const result = deferCopy ? withNativeCopyDeferred(this, invokeOriginal) : invokeOriginal();
			const selectionEnded = selectionWasActive && Reflect.get(this, "selectionPressActive") === false;
			if (selectionEnded) {
				const selection = nativeSelectionCompleted(this);
				if (selection) ensureSelectionRegistry().publishSelectionCompleted(selection);
			}
			if (textClick && parsed.type === "release") {
				finishTextClick(this, state, parsed, true);
				requestRender(this);
			}
			if (parsed.type === "release") state.nativePrimaryPress = undefined;
			return result;
		}

		if (state.textClick && parsed.type === "drag") {
			state.textClick.moved ||= parsed.x !== state.textClick.x || parsed.y !== state.textClick.y;
			if (state.textClick.moved) send(state.textClick.target, "drag", parsed);
			return Reflect.apply(original, this, [data]);
		}
		if (state.textClick && parsed.type === "release") {
			const result = Reflect.apply(original, this, [data]);
			finishTextClick(this, state, parsed, true);
			state.nativePrimaryPress = undefined;
			requestRender(this);
			return result;
		}

		// A component only owns a release after it handled the matching press. Keep
		// native selection gestures out of the general release dispatch path when a
		// stale layout makes an expanded fold report a release hit.
		if (state.nativePrimaryPress && (parsed.type === "drag" || parsed.type === "release")) {
			if (parsed.type === "release") state.nativePrimaryPress = undefined;
			return Reflect.apply(original, this, [data]);
		}

		if ((parsed.type === "drag" || parsed.type === "release") && state.capture) {
			const captured = state.capture;
			send(captured, parsed.type, parsed);
			if (parsed.type === "release") state.capture = undefined;
			requestRender(this);
			return { consume: true };
		}

		if (parsed.type === "move") {
			const previousHover = state.hover;
			if (previousHover && previousHover.frame === rendererLayoutFrame(this)) {
				if (containsTarget(previousHover, parsed) && send(previousHover, "move", parsed)) {
					return { consume: true };
				}
			}
			let next: MouseTarget | undefined;
			let handled = false;
			for (const target of targetsAt(this, parsed.x, parsed.y, true)) {
				const type = state.hover?.key === target.key ? "move" : "enter";
				if (!send(target, type, parsed)) continue;
				next = target;
				handled = true;
				break;
			}
			if (previousHover && previousHover.key !== next?.key) send(previousHover, "leave", parsed);
			state.hover = next;
			// Components request their own redraw when a move changes local state. The
			// bridge only redraws for target transitions, keeping raw motion storms O(1)
			// when the pointer remains over the same affordance.
			if (previousHover?.key !== next?.key) requestRender(this);
			return handled ? { consume: true } : Reflect.apply(original, this, [data]);
		}

		let prepassedOverlayKeys: ReadonlySet<object> | undefined;
		if (parsed.type === "press" && (parsed.rawButton & 3) === 0 && !defersInputToOverlay(this)) {
			let textTarget: MouseTarget | undefined;
			const dispatchedOverlayKeys = new Set<object>();
			prepassedOverlayKeys = dispatchedOverlayKeys;
			for (const target of targetsAt(this, parsed.x, parsed.y, true)) {
				if (target.overlayRegion) {
					dispatchedOverlayKeys.add(target.key);
					if (!send(target, "press", parsed)) continue;
					state.capture = target;
					setKeyboardTarget(state, undefined);
					requestRender(this);
					return { consume: true };
				}
				if (!target.textInteraction || !send(target, "press", parsed)) continue;
				textTarget = target;
				break;
			}
			if (textTarget) {
				state.textClick = { target: textTarget, x: parsed.x, y: parsed.y, moved: false };
				requestRender(this);
				return Reflect.apply(original, this, [data]);
			}
			setKeyboardTarget(state, undefined);
		}

		for (const target of targetsAt(this, parsed.x, parsed.y, true)) {
			if (prepassedOverlayKeys?.has(target.key)) continue;
			if (!send(target, parsed.type, parsed)) continue;
			if (parsed.type === "press") state.capture = target;
			requestRender(this);
			return { consume: true };
		}
		if (parsed.type === "press" && (parsed.rawButton & 3) === 0) state.nativePrimaryPress = true;
		return Reflect.apply(original, this, [data]);
	};

	let restored = false;
	const installation: BridgeInstallation = {
		protocol: "pi-libtui/mouse/bridge-installation/v1",
		refs: 1,
		patched,
		dispose() {
			if (restored) return;
			const current = Reflect.get(prototype, INSTALLATION_KEY) as PiPrivateValue;
			if (current !== installation) return;
			if (Reflect.get(prototype, "handleViewportInput") !== patched) return;
			restored = true;
			if (registryState.viewportPreserver === preserveViewport) registryState.viewportPreserver = undefined;
			for (const [renderer, state] of states) {
				if (state.lastPointer) {
					if (state.capture) send(state.capture, "release", { ...state.lastPointer, rawButton: 3 });
					if (state.hover) send(state.hover, "leave", state.lastPointer);
				}
				cancelTextClick(state, state.lastPointer);
				state.nativePrimaryPress = undefined;
				setKeyboardTarget(state, undefined);
				requestRender(renderer);
			}
			states.clear();
			removeFullscreenLayoutCapability();
			Reflect.set(prototype, "handleViewportInput", original);
			Reflect.set(prototype, INSTALLATION_KEY, undefined);
		},
	};
	Reflect.set(prototype, "handleViewportInput", patched);
	Reflect.set(prototype, INSTALLATION_KEY, installation);

	let disposed = false;
	return finish(() => {
		if (disposed) return;
		disposed = true;
		installation.refs -= 1;
		if (installation.refs === 0) installation.dispose();
	});
}
