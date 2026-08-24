import type { Component } from "@earendil-works/pi-tui";
import type { LayoutBox, LayoutFrame, LayoutScrollView, LayoutScrollViewReference, MouseRect } from "../mouse.ts";

// type-boundary: Pi 0.84.2's private fullscreen fields are untyped; these validators narrow each reflected value.
type PiPrivateValue = unknown;

export function isRecord(value: PiPrivateValue): value is Record<PropertyKey, PiPrivateValue> {
	return value !== null && typeof value === "object";
}

export function isRect(value: PiPrivateValue): value is MouseRect {
	if (!isRecord(value)) return false;
	return (
		typeof value.x === "number" &&
		typeof value.y === "number" &&
		typeof value.width === "number" &&
		typeof value.height === "number" &&
		Number.isFinite(value.x) &&
		Number.isFinite(value.y) &&
		Number.isFinite(value.width) &&
		Number.isFinite(value.height) &&
		value.width >= 0 &&
		value.height >= 0
	);
}

export function isComponent(value: PiPrivateValue): value is Component {
	if (!isRecord(value)) return false;
	return typeof value.render === "function" && typeof value.invalidate === "function";
}

function parseLayoutScrollView(value: PiPrivateValue): LayoutScrollView | undefined {
	if (!isRecord(value)) return undefined;
	const scrollTop = value.scrollTop;
	const viewportHeight = value.viewportHeight;
	if (
		typeof scrollTop !== "number" ||
		!Number.isFinite(scrollTop) ||
		typeof viewportHeight !== "number" ||
		!Number.isFinite(viewportHeight) ||
		viewportHeight < 0 ||
		typeof value.scrollTo !== "function"
	)
		return undefined;
	return value as unknown as LayoutScrollView;
}

export function parseLayoutScrollViewReference(value: PiPrivateValue): LayoutScrollViewReference | undefined {
	if (!isRecord(value) || typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop)) return undefined;
	return value as unknown as LayoutScrollViewReference;
}

function parseLayoutBox(value: PiPrivateValue, ancestors = new Set<object>()): LayoutBox | undefined {
	if (
		!isRecord(value) ||
		ancestors.has(value) ||
		!isComponent(value.component) ||
		!isRect(value.rect) ||
		!isRect(value.clip) ||
		!Array.isArray(value.children)
	)
		return undefined;
	ancestors.add(value);
	try {
		const children: LayoutBox[] = [];
		for (const child of value.children) {
			const parsed = parseLayoutBox(child, ancestors);
			if (!parsed) return undefined;
			children.push(parsed);
		}
		let scrollView: LayoutScrollViewReference | undefined;
		if (value.scrollView !== undefined) {
			scrollView = parseLayoutScrollViewReference(value.scrollView);
			if (!scrollView) return undefined;
		}
		let scrollContentLines: readonly string[] | undefined;
		if (value.scrollContentLines !== undefined) {
			if (
				!Array.isArray(value.scrollContentLines) ||
				!value.scrollContentLines.every((line) => typeof line === "string")
			)
				return undefined;
			scrollContentLines = value.scrollContentLines;
		}
		return { component: value.component, rect: value.rect, clip: value.clip, children, scrollView, scrollContentLines };
	} finally {
		ancestors.delete(value);
	}
}

function parseLayoutFrame(value: PiPrivateValue): LayoutFrame | undefined {
	if (!isRecord(value)) return undefined;
	const root = parseLayoutBox(value.root);
	if (!root) return undefined;
	let primaryScrollView: LayoutScrollView | undefined;
	if (value.primaryScrollView !== undefined) {
		primaryScrollView = parseLayoutScrollView(value.primaryScrollView);
		if (!primaryScrollView) return undefined;
	}
	return { root, primaryScrollView };
}

const parsedLayoutFrames = new WeakMap<object, { source: object; frame: LayoutFrame | undefined }>();

export function rendererLayoutFrame(renderer: object): LayoutFrame | undefined {
	const source = Reflect.get(renderer, "currentLayout") as PiPrivateValue;
	if (!source || typeof source !== "object") return undefined;
	const cached = parsedLayoutFrames.get(renderer);
	if (cached?.source === source) return cached.frame;
	const frame = parseLayoutFrame(source);
	parsedLayoutFrames.set(renderer, { source, frame });
	return frame;
}

export function contains(rect: MouseRect, x: number, y: number): boolean {
	return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

export function intersect(left: MouseRect, right: MouseRect): MouseRect {
	const x = Math.max(left.x, right.x);
	const y = Math.max(left.y, right.y);
	return {
		x,
		y,
		width: Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x),
		height: Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y),
	};
}

function structuralChildren(component: Component): readonly Component[] | undefined {
	const candidate = component as Component & {
		children?: readonly Component[];
		getChildren?: () => readonly Component[];
	};
	if (Array.isArray(candidate.children) && candidate.children.every(isComponent)) return candidate.children;
	// Shared stacks keep their children behind a method so replacement can preserve identity.
	if (typeof candidate.getChildren !== "function") return undefined;
	try {
		const children = candidate.getChildren.call(component);
		return Array.isArray(children) && children.every(isComponent) ? children : undefined;
	} catch {
		return undefined;
	}
}

function hasMouseHandler(component: Component): boolean {
	return typeof (component as Component & { onMouse?: PiPrivateValue }).onMouse === "function";
}

interface CachedStructuralSpan {
	component: Component;
	row: number;
	height: number;
	width: number;
}

function cachedStructuralSpans(component: Component): readonly CachedStructuralSpan[] | undefined {
	const candidate = component as Component & { getSpans?: PiPrivateValue };
	if (typeof candidate.getSpans !== "function") return undefined;
	let value: PiPrivateValue;
	try {
		value = Reflect.apply(candidate.getSpans, component, []) as PiPrivateValue;
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const spans: CachedStructuralSpan[] = [];
	for (const span of value) {
		if (
			!isRecord(span) ||
			!isComponent(span.component) ||
			typeof span.row !== "number" ||
			typeof span.height !== "number" ||
			typeof span.width !== "number" ||
			!Number.isFinite(span.row) ||
			!Number.isFinite(span.height) ||
			!Number.isFinite(span.width)
		)
			return [];
		spans.push({
			component: span.component,
			row: Math.max(0, Math.floor(span.row)),
			height: Math.max(0, Math.floor(span.height)),
			width: Math.max(0, Math.floor(span.width)),
		});
	}
	return spans;
}

function hasMouseDescendant(component: Component, ancestors = new Set<Component>()): boolean {
	if (ancestors.has(component)) return false;
	const children = structuralChildren(component);
	if (!children) return false;
	ancestors.add(component);
	const found = children.some((child) => hasMouseHandler(child) || hasMouseDescendant(child, ancestors));
	ancestors.delete(component);
	return found;
}

const derivedLayoutChildren = new WeakMap<LayoutBox, LayoutBox[]>();

export function derivedChildren(box: LayoutBox): readonly LayoutBox[] {
	if (box.children.length > 0) return box.children;
	const existing = derivedLayoutChildren.get(box);
	if (existing) return existing;
	const component = isComponent(box.component) ? box.component : undefined;
	if (!component || !hasMouseDescendant(component)) {
		derivedLayoutChildren.set(box, []);
		return [];
	}
	const cached = cachedStructuralSpans(component);
	if (cached) {
		const derived = cached.map((span) => {
			const rect = {
				x: box.rect.x,
				y: box.rect.y + span.row,
				width: Math.min(box.rect.width, span.width),
				height: span.height,
			};
			return { component: span.component, rect, clip: intersect(box.clip, rect), children: [] };
		});
		derivedLayoutChildren.set(box, derived);
		return derived;
	}
	const childrenToMeasure = structuralChildren(component);
	if (!childrenToMeasure) return [];
	const children: LayoutBox[] = [];
	let childY = box.rect.y;
	for (const child of childrenToMeasure) {
		let height: number;
		try {
			const lines = child.render(box.rect.width);
			if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return [];
			height = lines.length;
		} catch {
			return [];
		}
		const rect = { x: box.rect.x, y: childY, width: box.rect.width, height };
		children.push({ component: child, rect, clip: intersect(box.clip, rect), children: [] });
		childY += height;
	}
	derivedLayoutChildren.set(box, children);
	return children;
}

export function isVisibleComponent(frame: LayoutFrame, component: Component): boolean {
	let visible = false;
	const visit = (box: LayoutBox, ancestors: ReadonlySet<object>): void => {
		if (visible || ancestors.has(box.component)) return;
		if (box.component === component) {
			const clipped = intersect(box.rect, box.clip);
			visible = clipped.width > 0 && clipped.height > 0;
			return;
		}
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(box.component);
		for (const child of derivedChildren(box)) visit(child, nextAncestors);
	};
	visit(frame.root, new Set());
	return visible;
}

export function findScrollViewBox(frame: LayoutFrame, scrollView: object): LayoutBox | undefined {
	let result: LayoutBox | undefined;
	const visit = (box: LayoutBox): void => {
		if (result) return;
		if (box.scrollView === scrollView) {
			result = box;
			return;
		}
		for (const child of box.children) visit(child);
	};
	visit(frame.root);
	return result;
}

export function terminalSize(renderer: object): { rows: number; columns: number } | undefined {
	const terminal = Reflect.get(renderer, "terminal") as PiPrivateValue;
	if (!isRecord(terminal) || typeof terminal.rows !== "number" || typeof terminal.columns !== "number")
		return undefined;
	return { rows: terminal.rows, columns: terminal.columns };
}

export function rendererHasOverlay(renderer: object): boolean {
	const method = Reflect.get(renderer, "hasOverlay") as PiPrivateValue;
	if (typeof method !== "function") return false;
	try {
		return Reflect.apply(method, renderer, []) === true;
	} catch {
		return false;
	}
}

export function rendererHasSelection(renderer: object): boolean {
	return (
		Reflect.get(renderer, "selectionAnchor") !== undefined && Reflect.get(renderer, "selectionFocus") !== undefined
	);
}
