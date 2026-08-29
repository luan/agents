import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { compositeTuiLine, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import { renderKeyHint } from "../decoration/glyphs.ts";
import { renderPill } from "../decoration/powerline-pill.ts";
import type { MouseRect, MouseRegistry, ScreenDecorationContext } from "../mouse.ts";

export interface HoverTooltipTarget {
	readonly rect: MouseRect;
	readonly label: string;
	readonly shortcut?: KeyId;
}

export interface HoverTooltipMountOptions {
	readonly id: string;
	readonly theme: Theme;
	readonly registry: MouseRegistry;
	readonly priority?: number;
	readonly pointerPriority?: number;
	getTarget(screen: readonly string[], context: ScreenDecorationContext): HoverTooltipTarget | undefined;
}

export interface HoverTooltipMount {
	dispose(): void;
}

/** Find one visible plain-text span in an ANSI-styled screen. */
export function findScreenTextRect(screen: readonly string[], text: string): MouseRect | undefined {
	for (const [row, line] of screen.entries()) {
		const plain = stripTerminalSequences(line);
		const index = plain.indexOf(text);
		if (index < 0) continue;
		return {
			x: visibleWidth(plain.slice(0, index)),
			y: row,
			width: visibleWidth(text),
			height: 1,
		};
	}
	return undefined;
}

/** Mount a pointer-hover tooltip over any screen-locatable target. */
export function mountHoverTooltip(options: HoverTooltipMountOptions): HoverTooltipMount {
	let target: HoverTooltipTarget | undefined;
	let hovered = false;
	let disposed = false;
	const removeDecorator = options.registry.registerScreenDecorator({
		id: options.id,
		priority: options.priority ?? 5_000,
		decorate(screen, context) {
			target = context.hasOverlay ? undefined : options.getTarget(screen, context);
			if (!target) hovered = false;
			return hovered && target ? compositeHoverTooltip(screen, context, options.theme, target) : screen;
		},
	});
	const removeRegion = options.registry.registerOverlayRegion({
		id: options.id,
		priority: options.pointerPriority ?? 500,
		getRect: () => target?.rect,
		onMouse(event) {
			const next = event.type !== "leave";
			const changed = hovered !== next;
			hovered = next;
			return changed || next;
		},
	});
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			target = undefined;
			hovered = false;
			removeDecorator();
			removeRegion();
		},
	};
}

/** Composite a dim, borderless tooltip pill adjacent to a hovered target. */
export function compositeHoverTooltip(
	screen: readonly string[],
	context: Pick<ScreenDecorationContext, "width" | "height">,
	theme: Theme,
	target: HoverTooltipTarget,
): string[] {
	const label = sanitizeTuiText(target.label).replaceAll("\n", " ").trim();
	if (!label || context.width < 3 || context.height < 2) return [...screen];
	const hint = target.shortcut ? ` ${renderKeyHint(theme, target.shortcut)}` : "";
	const pill = renderPill(
		theme,
		{ icon: false, label: truncateToWidth(`${label}${hint}`, Math.max(1, context.width - 2), "") },
		"surface.inset",
		"text.muted",
		undefined,
		"\x1b[49m",
		true,
	);
	const width = Math.min(context.width, visibleWidth(pill));
	if (width === 0) return [...screen];
	const below = target.rect.y + target.rect.height;
	const y = below < context.height ? below : Math.max(0, target.rect.y - 1);
	const center = target.rect.x + target.rect.width / 2;
	const x = Math.max(0, Math.min(context.width - width, Math.round(center - width / 2)));
	const result = [...screen];
	result[y] = compositeTuiLine(result[y] ?? "", pill, x, width, context.width);
	return result;
}
