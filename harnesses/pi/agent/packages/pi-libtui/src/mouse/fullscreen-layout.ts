import type { SelectionPoint } from "../selection.ts";
import type { MouseRect } from "./events.ts";
import type { ViewportRect } from "./registry.ts";

/** Versioned host capability for Pi's validated fullscreen transcript layout. */
export const FULLSCREEN_LAYOUT_CAPABILITY_KEY = Symbol.for("pi-libtui/fullscreen-layout/v1");
export const FULLSCREEN_LAYOUT_PROTOCOL = "pi-libtui/fullscreen-layout/v1" as const;

/** The private scroll-view shape exposed through the fullscreen layout capability. */
export interface LayoutScrollViewReference {
	readonly scrollTop: number;
}

/** The primary transcript scroll view with viewport and scrolling controls. */
export interface LayoutScrollView extends LayoutScrollViewReference {
	readonly viewportHeight: number;
	scrollTo(row: number, options?: { disableFollow?: boolean }): void;
}

/** A validated component layout box supplied by the Pi host bridge. */
export interface LayoutBox {
	readonly component: object;
	readonly rect: MouseRect;
	readonly clip: MouseRect;
	readonly children: readonly LayoutBox[];
	readonly scrollView?: LayoutScrollViewReference;
	readonly scrollContentLines?: readonly string[];
}

/** A validated Pi layout frame. The primary scroll view is absent on non-transcript layouts. */
export interface LayoutFrame {
	readonly root: LayoutBox;
	readonly primaryScrollView?: LayoutScrollView;
}

/** A selection point tied to the scroll view that owns its logical row. */
export interface LayoutSelectionPoint extends SelectionPoint {
	readonly scrollView: LayoutScrollView;
	readonly boundary?: boolean;
}

/** Current validated fullscreen transcript geometry and selection mapping. */
export interface FullscreenLayout {
	readonly frame: LayoutFrame;
	readonly primaryBox: LayoutBox;
	readonly primaryScrollView: LayoutScrollView;
	readonly lines: readonly string[];
	readonly viewport: ViewportRect;
	readonly selectionAnchor: LayoutSelectionPoint | undefined;
	readonly selectionFocus: LayoutSelectionPoint | undefined;
	setSelection(anchor: LayoutSelectionPoint | undefined, focus: LayoutSelectionPoint | undefined): void;
	point(point: SelectionPoint, boundary?: boolean): LayoutSelectionPoint;
	screenPoint(point: SelectionPoint): SelectionPoint;
}

/** UI-free provider for current Pi fullscreen layout state. */
export interface FullscreenLayoutCapability {
	readonly protocol: typeof FULLSCREEN_LAYOUT_PROTOCOL;
	readonly version: 1;
	resolve(renderer: object): FullscreenLayout | undefined;
}

// type-boundary: Symbol.for can contain a capability from another extension realm; this validator narrows its public shape.
type UntrustedLayoutValue = unknown;

function isRecord(value: UntrustedLayoutValue): value is Record<PropertyKey, UntrustedLayoutValue> {
	return value !== null && typeof value === "object";
}

function isFiniteNumber(value: UntrustedLayoutValue): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isLayoutRect(value: UntrustedLayoutValue): value is MouseRect {
	if (!isRecord(value)) return false;
	return (
		isFiniteNumber(value.x) &&
		isFiniteNumber(value.y) &&
		isFiniteNumber(value.width) &&
		isFiniteNumber(value.height) &&
		value.width >= 0 &&
		value.height >= 0
	);
}

function isLayoutScrollView(value: UntrustedLayoutValue): value is LayoutScrollView {
	if (!isRecord(value)) return false;
	return (
		isFiniteNumber(value.scrollTop) &&
		isFiniteNumber(value.viewportHeight) &&
		value.viewportHeight >= 0 &&
		typeof value.scrollTo === "function"
	);
}

function isLayoutScrollViewReference(value: UntrustedLayoutValue): value is LayoutScrollViewReference {
	return isRecord(value) && isFiniteNumber(value.scrollTop);
}

function isLayoutBox(value: UntrustedLayoutValue, ancestors = new Set<object>()): value is LayoutBox {
	if (!isRecord(value) || ancestors.has(value)) return false;
	if (
		!isRecord(value.component) ||
		!isLayoutRect(value.rect) ||
		!isLayoutRect(value.clip) ||
		!Array.isArray(value.children)
	)
		return false;
	if (value.scrollView !== undefined && !isLayoutScrollViewReference(value.scrollView)) return false;
	if (
		value.scrollContentLines !== undefined &&
		(!Array.isArray(value.scrollContentLines) || !value.scrollContentLines.every((line) => typeof line === "string"))
	)
		return false;
	ancestors.add(value);
	const valid = value.children.every((child) => isLayoutBox(child, ancestors));
	ancestors.delete(value);
	return valid;
}

function isLayoutFrame(value: UntrustedLayoutValue): value is LayoutFrame {
	if (!isRecord(value) || !isLayoutBox(value.root)) return false;
	return value.primaryScrollView === undefined || isLayoutScrollView(value.primaryScrollView);
}

function isLayoutSelectionPoint(value: UntrustedLayoutValue): value is LayoutSelectionPoint {
	if (!isRecord(value)) return false;
	return isFiniteNumber(value.row) && isFiniteNumber(value.col) && isLayoutScrollView(value.scrollView);
}

function containsLayoutBox(
	root: LayoutBox,
	target: UntrustedLayoutValue,
	ancestors = new Set<object>(),
): target is LayoutBox {
	if (root === target) return true;
	if (ancestors.has(root)) return false;
	ancestors.add(root);
	try {
		return root.children.some((child) => containsLayoutBox(child, target, ancestors));
	} finally {
		ancestors.delete(root);
	}
}

function isFullscreenLayout(value: UntrustedLayoutValue): value is FullscreenLayout {
	try {
		if (!isRecord(value) || !isLayoutFrame(value.frame) || !containsLayoutBox(value.frame.root, value.primaryBox))
			return false;
		const viewport = value.viewport as UntrustedLayoutValue;
		if (
			!isLayoutScrollView(value.primaryScrollView) ||
			value.frame.primaryScrollView !== value.primaryScrollView ||
			value.primaryBox.scrollView !== value.primaryScrollView ||
			!Array.isArray(value.lines) ||
			!value.lines.every((line) => typeof line === "string") ||
			value.primaryBox.scrollContentLines !== value.lines ||
			!isLayoutRect(viewport) ||
			!isFiniteNumber(isRecord(viewport) ? viewport.scrollTop : undefined) ||
			(isRecord(viewport) ? viewport.scrollTop : undefined) !== value.primaryScrollView.scrollTop ||
			typeof value.setSelection !== "function" ||
			typeof value.point !== "function" ||
			typeof value.screenPoint !== "function"
		)
			return false;
		const expectedX = Math.max(value.primaryBox.rect.x, value.primaryBox.clip.x);
		const expectedY = Math.max(value.primaryBox.rect.y, value.primaryBox.clip.y);
		const expectedWidth = Math.max(
			0,
			Math.min(
				value.primaryBox.rect.x + value.primaryBox.rect.width,
				value.primaryBox.clip.x + value.primaryBox.clip.width,
			) - expectedX,
		);
		const expectedHeight = Math.max(
			0,
			Math.min(
				value.primaryBox.rect.y + value.primaryBox.rect.height,
				value.primaryBox.clip.y + value.primaryBox.clip.height,
			) - expectedY,
		);
		if (
			expectedWidth <= 0 ||
			expectedHeight <= 0 ||
			viewport.x !== expectedX ||
			viewport.y !== expectedY ||
			viewport.width !== expectedWidth ||
			viewport.height !== expectedHeight
		)
			return false;
		if (value.selectionAnchor !== undefined && !isLayoutSelectionPoint(value.selectionAnchor)) return false;
		if (value.selectionFocus !== undefined && !isLayoutSelectionPoint(value.selectionFocus)) return false;
		return (
			(value.selectionAnchor === undefined || value.selectionAnchor.scrollView === value.primaryScrollView) &&
			(value.selectionFocus === undefined || value.selectionFocus.scrollView === value.primaryScrollView)
		);
	} catch {
		return false;
	}
}

function isFullscreenLayoutCapability(value: UntrustedLayoutValue): value is FullscreenLayoutCapability {
	try {
		if (!isRecord(value)) return false;
		const candidate = value as Partial<FullscreenLayoutCapability>;
		return (
			candidate.protocol === FULLSCREEN_LAYOUT_PROTOCOL &&
			candidate.version === 1 &&
			typeof candidate.resolve === "function"
		);
	} catch {
		return false;
	}
}

/** Read the optional host-provided fullscreen layout capability without creating one. */
export function getFullscreenLayoutCapability(
	scope: typeof globalThis = globalThis,
): FullscreenLayoutCapability | undefined {
	try {
		const slots = scope as Record<PropertyKey, UntrustedLayoutValue>;
		const candidate = slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY];
		return isFullscreenLayoutCapability(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/** Publish the host-owned fullscreen layout provider and return an identity-safe disposer. */
export function publishFullscreenLayoutCapability(
	capability: FullscreenLayoutCapability,
	scope: typeof globalThis = globalThis,
): () => void {
	const slots = scope as Record<PropertyKey, UntrustedLayoutValue>;
	const existing = slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY];
	if (isFullscreenLayoutCapability(existing) && existing !== capability) return () => {};
	if (existing !== capability) slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY] = capability;
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		if (slots[FULLSCREEN_LAYOUT_CAPABILITY_KEY] === capability)
			Reflect.deleteProperty(slots, FULLSCREEN_LAYOUT_CAPABILITY_KEY);
	};
}

/** Resolve current fullscreen geometry, tolerating an absent, incompatible, or malformed provider. */
export function resolveFullscreenLayout(
	renderer: object,
	scope: typeof globalThis = globalThis,
): FullscreenLayout | undefined {
	const capability = getFullscreenLayoutCapability(scope);
	if (!capability) return undefined;
	try {
		const layout = capability.resolve(renderer);
		return isFullscreenLayout(layout) ? layout : undefined;
	} catch {
		return undefined;
	}
}
