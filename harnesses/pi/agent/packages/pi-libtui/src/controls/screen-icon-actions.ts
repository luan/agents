import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, type KeyId, visibleWidth } from "@earendil-works/pi-tui";
import { backgroundAnsiAtColumn, renderPill } from "../decoration/powerline-pill.ts";
import type { MouseRect, MouseRegistry } from "../mouse.ts";
import { compositeHoverTooltip } from "../overlay/hover-tooltip.ts";

export interface ScreenIconAction<Value extends string = string> {
	readonly value: Value;
	readonly glyph: string | (() => string);
	readonly tooltip: string | (() => string);
	readonly shortcuts?: readonly KeyId[];
	readonly visible?: () => boolean;
}

export interface ScreenIconActionsOptions<Value extends string> {
	readonly id: string;
	readonly theme: Theme;
	readonly registry: MouseRegistry;
	readonly actions: readonly ScreenIconAction<Value>[];
	readonly priority?: number;
	readonly pointerPriority?: number;
	onActivate(value: Value): void;
}

export interface ScreenIconActionsMount {
	readonly reservedWidth: number;
	dispose(): void;
}

interface ActionGeometry<Value extends string> extends MouseRect {
	readonly value: Value;
}

function resolvedText(value: string | (() => string)): string {
	return typeof value === "function" ? value() : value;
}

/** Width reserved by a top-right icon action group with the given maximum action count. */
export function screenIconActionsWidth(actionCount: number): number {
	return Math.max(0, Math.floor(actionCount)) * 3 + Math.max(0, Math.floor(actionCount) - 1);
}

/** Mount icon-only actions at the terminal's top-right corner, with hover tooltips. */
export function mountScreenIconActions<Value extends string>(
	options: ScreenIconActionsOptions<Value>,
): ScreenIconActionsMount {
	let geometry: readonly ActionGeometry<Value>[] = [];
	let hovered: Value | undefined;
	let pressed: Value | undefined;
	let disposed = false;
	const removeDecorator = options.registry.registerScreenDecorator({
		id: options.id,
		priority: options.priority ?? 10_000,
		decorate(screen, context) {
			if (context.hasOverlay) {
				geometry = [];
				hovered = undefined;
				pressed = undefined;
				return screen;
			}
			const visible = options.actions.filter((action) => action.visible?.() !== false);
			const rendered = visible.map((action) => {
				const active = action.value === hovered || action.value === pressed;
				return renderPill(
					options.theme,
					{ icon: { glyph: resolvedText(action.glyph) }, label: "" },
					active ? "surface.selected" : "surface.inset",
					active ? "accent" : "text.primary",
					undefined,
					"\x1b[49m",
				);
			});
			const gap = 1;
			const widths = rendered.map(visibleWidth);
			const barWidth = widths.reduce((total, width) => total + width, 0) + gap * Math.max(0, rendered.length - 1);
			const x = Math.max(0, context.width - barWidth);
			let cursor = x;
			geometry = visible.map((action, index) => {
				const width = widths[index] ?? 0;
				const item = { x: cursor, y: 0, width, height: 1, value: action.value };
				cursor += width + gap;
				return item;
			});
			if (rendered.length === 0) return screen;
			const base = screen[0] ?? "";
			const destination = backgroundAnsiAtColumn(base, x);
			const row = rendered.join(`${destination} ${destination}`);
			const result = [...screen];
			result[0] = compositeTuiLine(base, row, x, barWidth, context.width);
			const action = visible.find((candidate) => candidate.value === hovered);
			const rect = geometry.find((candidate) => candidate.value === hovered);
			return action && rect
				? compositeHoverTooltip(result, context, options.theme, {
						rect,
						label: resolvedText(action.tooltip),
						...(action.shortcuts?.[0] ? { shortcut: action.shortcuts[0] } : {}),
					})
				: result;
		},
	});
	const removeRegions = options.actions.map((action) =>
		options.registry.registerOverlayRegion({
			id: `${options.id}.${action.value}`,
			priority: options.pointerPriority ?? 1_000,
			getRect: () => geometry.find((candidate) => candidate.value === action.value),
			onMouse(event) {
				if (event.type === "leave") {
					if (hovered === action.value) hovered = undefined;
					if (pressed === action.value) pressed = undefined;
					return false;
				}
				hovered = action.value;
				if (event.type === "press" && event.button === 0) pressed = action.value;
				if (event.type === "release" && event.button === 0) {
					pressed = undefined;
					options.onActivate(action.value);
				}
				return true;
			},
		}),
	);
	return {
		reservedWidth: screenIconActionsWidth(options.actions.length),
		dispose() {
			if (disposed) return;
			disposed = true;
			geometry = [];
			hovered = undefined;
			pressed = undefined;
			removeDecorator();
			for (const remove of removeRegions) remove();
		},
	};
}
