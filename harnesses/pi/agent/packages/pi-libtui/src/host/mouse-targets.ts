import type { Component } from "@earendil-works/pi-tui";
import { getMouseRegistryState } from "../mouse/registry.ts";
import type {
	LayoutBox,
	LayoutFrame,
	MouseRect,
	MouseRegistry,
	TextInteractionTarget,
	TuiMouseEvent,
} from "../mouse.ts";
import { TEXT_INTERACTION_TARGET } from "../mouse.ts";
import {
	contains,
	derivedChildren,
	isComponent,
	isRecord,
	isRect,
	rendererLayoutFrame,
	terminalSize,
} from "./pi-layout-adapter.ts";

// type-boundary: Pi 0.84.2's private input and overlay members are narrowed by the validators below.
type PiPrivateValue = unknown;

type MouseHandler = (event: TuiMouseEvent) => boolean;

interface OverlayEntry {
	component: Component;
	options?: PiPrivateValue;
}

export interface MouseTarget {
	key: object;
	getRect(): MouseRect | undefined;
	containsPoint?(x: number, y: number): boolean;
	isCurrent?(): boolean;
	dispatch(event: TuiMouseEvent): boolean;
	frame?: LayoutFrame;
	textInteraction?: Component & TextInteractionTarget;
	overlayRegion?: boolean;
}

function parseOverlayEntry(value: PiPrivateValue): OverlayEntry | undefined {
	if (!isRecord(value) || !isComponent(value.component)) return undefined;
	return { component: value.component, options: value.options };
}

function safeCall(handler: MouseHandler, receiver: object, event: TuiMouseEvent): boolean {
	try {
		return Reflect.apply(handler, receiver, [event]) === true;
	} catch {
		return false;
	}
}

function mouseHandler(component: Component): MouseHandler | undefined {
	const candidate = component as Component & { onMouse?: PiPrivateValue };
	return typeof candidate.onMouse === "function" ? (candidate.onMouse as MouseHandler) : undefined;
}

function textInteractionTarget(component: Component): (Component & TextInteractionTarget) | undefined {
	const candidate = component as Component & Partial<TextInteractionTarget>;
	return candidate[TEXT_INTERACTION_TARGET] === true &&
		typeof candidate.handleViewportInput === "function" &&
		typeof candidate.setViewportFocus === "function"
		? (candidate as Component & TextInteractionTarget)
		: undefined;
}

const cachedComponentTargetBoxes = new WeakMap<LayoutFrame, Array<{ box: LayoutBox; depth: number }>>();
const cachedComponentTargets = new WeakMap<LayoutFrame, Map<string, MouseTarget[]>>();

function componentTargets(frame: LayoutFrame, x: number, y: number): MouseTarget[] {
	let pointCache = cachedComponentTargets.get(frame);
	if (!pointCache) {
		pointCache = new Map();
		cachedComponentTargets.set(frame, pointCache);
	}
	const point = `${x}:${y}`;
	const cached = pointCache.get(point);
	if (cached) return cached;
	let candidates = cachedComponentTargetBoxes.get(frame);
	if (!candidates) {
		candidates = [];
		const ancestors = new Set<object>();
		const visit = (box: LayoutBox, depth: number): void => {
			if (ancestors.has(box.component)) return;
			const component = isComponent(box.component) ? box.component : undefined;
			if (component && mouseHandler(component)) candidates?.push({ box, depth });
			ancestors.add(box.component);
			for (const child of derivedChildren(box)) visit(child, depth + 1);
			ancestors.delete(box.component);
		};
		visit(frame.root, 0);
		candidates.sort((left, right) => right.depth - left.depth);
		cachedComponentTargetBoxes.set(frame, candidates);
	}
	const targets: MouseTarget[] = candidates
		.filter(({ box }) => contains(box.clip, x, y) && contains(box.rect, x, y))
		.map(({ box }) => ({
			key: box.component,
			frame,
			// The layout walk already resolved this box for the current input frame.
			// Rewalking here made dispatch quadratic and could rerender descendants.
			getRect: () => box.rect,
			containsPoint: (pointX, pointY) => contains(box.rect, pointX, pointY) && contains(box.clip, pointX, pointY),
			textInteraction: isComponent(box.component) ? textInteractionTarget(box.component) : undefined,
			dispatch: (event) => {
				const component = isComponent(box.component) ? box.component : undefined;
				const handler = component ? mouseHandler(component) : undefined;
				return handler && component ? safeCall(handler, component, event) : false;
			},
		}));
	if (pointCache.size >= 256) pointCache.clear();
	pointCache.set(point, targets);
	return targets;
}

function overlayTargets(registry: MouseRegistry, x: number, y: number): MouseTarget[] {
	const matches: Array<{ target: MouseTarget; priority: number; order: number }> = [];
	const regions = getMouseRegistryState(registry).regions;
	for (let index = 0; index < regions.length; index += 1) {
		const region = regions[index]!;
		let rect: MouseRect | undefined;
		try {
			rect = region.getRect();
		} catch {
			continue;
		}
		if (!rect || !isRect(rect) || !contains(rect, x, y)) continue;
		const target: MouseTarget = {
			key: region,
			overlayRegion: true,
			isCurrent: () => getMouseRegistryState(registry).regions.includes(region),
			getRect: () => {
				try {
					const current = region.getRect();
					return current && isRect(current) ? current : undefined;
				} catch {
					return undefined;
				}
			},
			dispatch: (event) => safeCall(region.onMouse, region, event),
		};
		const priority = typeof region.priority === "number" && Number.isFinite(region.priority) ? region.priority : 0;
		matches.push({ target, priority, order: index });
	}
	matches.sort((left, right) => right.priority - left.priority || right.order - left.order);
	return matches.map(({ target }) => target);
}

export function focusedOverlayTarget(renderer: object, x: number, y: number): MouseTarget | undefined {
	const topmost = Reflect.get(renderer, "getTopmostVisibleOverlay") as PiPrivateValue;
	const resolveLayout = Reflect.get(renderer, "resolveOverlayLayout") as PiPrivateValue;
	if (typeof topmost !== "function" || typeof resolveLayout !== "function") return undefined;
	let entry: OverlayEntry | undefined;
	try {
		entry = parseOverlayEntry(Reflect.apply(topmost, renderer, []) as PiPrivateValue);
	} catch {
		return undefined;
	}
	if (!entry || !mouseHandler(entry.component)) return undefined;

	const getRect = (): MouseRect | undefined => {
		const size = terminalSize(renderer);
		if (!size) return undefined;
		try {
			const initial = Reflect.apply(resolveLayout, renderer, [
				entry.options,
				0,
				size.columns,
				size.rows,
			]) as PiPrivateValue;
			if (!isRecord(initial) || typeof initial.width !== "number") return undefined;
			const width = Math.max(1, Math.floor(initial.width));
			const lines = entry.component.render(width);
			if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
			const maxHeight = typeof initial.maxHeight === "number" ? Math.max(1, Math.floor(initial.maxHeight)) : undefined;
			const height = maxHeight === undefined ? lines.length : Math.min(lines.length, maxHeight);
			const final = Reflect.apply(resolveLayout, renderer, [
				entry.options,
				height,
				size.columns,
				size.rows,
			]) as PiPrivateValue;
			if (
				!isRecord(final) ||
				typeof final.row !== "number" ||
				typeof final.col !== "number" ||
				typeof final.width !== "number"
			) {
				return undefined;
			}
			return { x: final.col, y: final.row, width: final.width, height };
		} catch {
			return undefined;
		}
	};
	const rect = getRect();
	if (!rect || !contains(rect, x, y)) return undefined;
	return {
		key: entry.component,
		frame: rendererLayoutFrame(renderer),
		getRect: () => rect,
		isCurrent: () => {
			try {
				return parseOverlayEntry(Reflect.apply(topmost, renderer, []) as PiPrivateValue)?.component === entry.component;
			} catch {
				return false;
			}
		},
		textInteraction: textInteractionTarget(entry.component),
		dispatch: (event) => {
			const handler = mouseHandler(entry.component);
			return handler ? safeCall(handler, entry.component, event) : false;
		},
	};
}

export function targetsAt(
	registry: MouseRegistry,
	renderer: object,
	x: number,
	y: number,
	includeLayout: boolean,
	defersInputToOverlay: (renderer: object) => boolean,
): MouseTarget[] {
	const targets = overlayTargets(registry, x, y);
	if (!includeLayout) return targets;
	if (defersInputToOverlay(renderer)) {
		const focusedOverlay = focusedOverlayTarget(renderer, x, y);
		if (focusedOverlay) targets.push(focusedOverlay);
		return targets;
	}
	const frame = rendererLayoutFrame(renderer);
	if (frame) targets.push(...componentTargets(frame, x, y));
	return targets;
}
