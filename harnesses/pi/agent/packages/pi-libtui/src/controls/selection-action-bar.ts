import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, compositeTuiLine, type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getTuiAppearance } from "../appearance.ts";
import { tuiTheme } from "../color/theme.ts";
import { getTuiPillSeparators, icon, keyHintGlyph, type TuiIconName } from "../decoration/glyphs.ts";
import { backgroundAnsiAtColumn } from "../decoration/powerline-pill.ts";
import type { MouseRect, MouseRegistry, ScreenDecorationContext, TuiMouseEvent, ViewportRect } from "../mouse.ts";
import type { SelectionPoint } from "../selection.ts";

/** One domain-owned action displayed by {@link SelectionActionBar}. */
export interface SelectionActionBarAction<Value extends string = string> {
	/** Stable value passed to the activation callback. */
	value: Value;
	/** Short action label. */
	label: string;
	/** Optional semantic action icon. */
	icon?: TuiIconName;
	/** User-configured shortcuts; the first is displayed and every shortcut activates. */
	shortcuts?: readonly KeyId[];
}

/** Absolute or component-local geometry for one rendered action. */
export interface SelectionActionBarItemGeometry<Value extends string = string> extends MouseRect {
	index: number;
	value: Value;
}

/** Geometry recorded by the most recent action-bar render. */
export interface SelectionActionBarGeometry<Value extends string = string> extends MouseRect {
	actions: readonly SelectionActionBarItemGeometry<Value>[];
}

/** Construction options for {@link SelectionActionBar}. */
export interface SelectionActionBarOptions<Value extends string> {
	/** Active Pi theme used for semantic colors. */
	theme: Theme;
	/** Domain-owned actions in visual order. */
	actions: readonly SelectionActionBarAction<Value>[];
	/** Request a host render after pointer state changes. */
	requestRender(): void;
	/** Receive a clicked or keyboard-activated action value. */
	onActivate(value: Value): void;
}

/** A visible selection that can anchor a mounted action bar. */
export interface SelectionActionBarTarget {
	/** Visible selection endpoints in absolute terminal coordinates. */
	selection: { start: SelectionPoint; end: SelectionPoint };
	/** Plain selected text used to refine placement when geometry includes trailing cells. */
	selectedText?: string;
}

/** Host integration for a screen-positioned {@link SelectionActionBar}. */
export interface SelectionActionBarMountOptions<Value extends string> extends SelectionActionBarOptions<Value> {
	/** Shared fullscreen decoration and pointer registry. */
	registry: MouseRegistry;
	/** Stable diagnostic identity shared by the decorator and pointer region. */
	id: string;
	/** Screen decoration priority. Defaults to zero. */
	priority?: number;
	/** Pointer hit priority. Defaults to 200. */
	pointerPriority?: number;
	/** Resolve the current eligible selection, or hide the bar. */
	getTarget(context: ScreenDecorationContext): SelectionActionBarTarget | undefined;
	/** Additional host visibility gate when the decoration context is not authoritative. */
	isHidden?(): boolean;
}

/** Lifecycle returned by {@link mountSelectionActionBar}. */
export interface SelectionActionBarMount {
	/** Clear current placement and pointer geometry until the next decoration pass. */
	invalidate(): void;
	/** Remove the decorator and pointer region. Idempotent. */
	dispose(): void;
}

/** Inputs for positioning a selection action bar around a visible selection. */
export interface SelectionActionBarPlacementRequest {
	/** Visible selection endpoints in absolute terminal coordinates. */
	selection: { start: SelectionPoint; end: SelectionPoint };
	/**
	 * Plain text represented by the selection. When a one-row selection has a
	 * terminal endpoint beyond its content (for example, a line selection), its
	 * first line supplies the visual span used to center the bar.
	 */
	selectedText?: string;
	/** Natural or fitted action-bar width. */
	barWidth: number;
	/** Complete terminal width. */
	screenWidth: number;
	/** Complete terminal height. */
	screenHeight: number;
	/** Optional transcript viewport used to keep the bar beside transcript content. */
	viewport?: ViewportRect;
}

/**
 * Center a one-row action bar above a selection, flipping below at the top edge.
 * @param request Selection geometry, bar width, terminal bounds, and optional transcript viewport.
 * @returns A visible absolute terminal rectangle, or undefined when neither adjacent row is available.
 */
export function placeSelectionActionBar(request: SelectionActionBarPlacementRequest): MouseRect | undefined {
	const width = Math.min(Math.max(0, Math.floor(request.barWidth)), Math.max(0, request.screenWidth));
	if (width === 0 || request.screenHeight <= 0) return undefined;
	const top = Math.min(request.selection.start.row, request.selection.end.row);
	const bottom = Math.max(request.selection.start.row, request.selection.end.row);
	const boundsTop = request.viewport?.y ?? 0;
	const boundsBottom = request.viewport ? request.viewport.y + request.viewport.height - 1 : request.screenHeight - 1;
	const y = top - 1 >= boundsTop ? top - 1 : bottom + 1 <= boundsBottom ? bottom + 1 : undefined;
	if (y === undefined || y < 0 || y >= request.screenHeight) return undefined;
	const leftBound = request.viewport?.x ?? 0;
	const rightBound = request.viewport
		? Math.min(request.screenWidth, request.viewport.x + request.viewport.width)
		: request.screenWidth;
	const effectiveWidth = Math.min(width, Math.max(0, rightBound - leftBound));
	if (effectiveWidth === 0) return undefined;
	const sameRow = request.selection.start.row === request.selection.end.row;
	const selectionStartColumn = Math.min(request.selection.start.col, request.selection.end.col);
	const selectionEndColumn = Math.max(request.selection.start.col, request.selection.end.col);
	const selectedLineWidth = sameRow ? visibleWidth(request.selectedText?.split("\n", 1)[0] ?? "") : 0;
	const endColumn =
		selectedLineWidth > 0 ? Math.min(selectionEndColumn, selectionStartColumn + selectedLineWidth) : selectionEndColumn;
	const center = sameRow
		? selectedLineWidth > 0
			? (selectionStartColumn + endColumn) / 2
			: (request.selection.start.col + request.selection.end.col + 1) / 2
		: request.selection.start.col;
	const x = Math.max(leftBound, Math.min(rightBound - effectiveWidth, Math.round(center - effectiveWidth / 2)));
	return { x, y, width: effectiveWidth, height: 1 };
}

/**
 * Mount a selection action bar into the shared fullscreen decorator and pointer registries.
 * The consumer owns action meaning and selection eligibility; pi-libtui owns presentation mechanics.
 */
export function mountSelectionActionBar<Value extends string>(
	options: SelectionActionBarMountOptions<Value>,
): SelectionActionBarMount {
	let placement: MouseRect | undefined;
	let disposed = false;
	const invalidate = () => {
		placement = undefined;
		bar.invalidate();
	};
	const bar = new SelectionActionBar({
		theme: options.theme,
		actions: options.actions,
		requestRender: options.requestRender,
		onActivate(value) {
			invalidate();
			options.onActivate(value);
		},
	});
	const removeDecorator = options.registry.registerScreenDecorator({
		id: options.id,
		priority: options.priority,
		decorate(screen, context) {
			const target = context.hasOverlay || options.isHidden?.() === true ? undefined : options.getTarget(context);
			if (!target) {
				invalidate();
				return screen;
			}
			bar.render(context.viewport?.width ?? context.width);
			const barWidth = bar.getGeometry()?.width ?? 0;
			placement = placeSelectionActionBar({
				selection: target.selection,
				...(target.selectedText !== undefined ? { selectedText: target.selectedText } : {}),
				barWidth,
				screenWidth: context.width,
				screenHeight: context.height,
				viewport: context.viewport,
			});
			return placement ? bar.composite(screen, placement) : screen;
		},
	});
	const removeRegion = options.registry.registerOverlayRegion({
		id: options.id,
		priority: options.pointerPriority ?? 200,
		getRect: () => placement,
		onMouse: (event) => bar.onMouse(event),
	});
	return {
		invalidate,
		dispose() {
			if (disposed) return;
			disposed = true;
			invalidate();
			removeDecorator();
			removeRegion();
		},
	};
}

/** Connected, one-row selection action surface with keyboard and pointer handling. */
export class SelectionActionBar<Value extends string = string> implements Component {
	private hoverIndex: number | undefined;
	private pressedIndex: number | undefined;
	private geometry: SelectionActionBarGeometry<Value> | undefined;

	constructor(private readonly config: SelectionActionBarOptions<Value>) {}

	/**
	 * Match every configured shortcut and activate its action.
	 * @param data Raw terminal input.
	 * @returns True when the bar consumed a configured shortcut.
	 */
	handleInput(data: string): boolean {
		const index = this.config.actions.findIndex((action) => action.shortcuts?.some((key) => matchesKey(data, key)));
		if (index < 0) return false;
		this.activate(index);
		return true;
	}

	/** Handle pointer input in bar-local coordinates. */
	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "drag" || event.type === "wheel") return false;
		if (event.type === "leave") {
			const changed = this.hoverIndex !== undefined || this.pressedIndex !== undefined;
			this.hoverIndex = undefined;
			this.pressedIndex = undefined;
			if (changed) this.config.requestRender();
			return false;
		}
		const action = this.geometry?.actions.find(
			(candidate) => event.col >= candidate.x && event.col < candidate.x + candidate.width,
		);
		this.updateHover(action?.index);
		if (event.type === "press" && (event.button === undefined || event.button === 0)) {
			this.pressedIndex = action?.index;
		} else if (event.type === "release" && (event.button === undefined || event.button === 0)) {
			const pressed = this.pressedIndex;
			this.pressedIndex = undefined;
			if (action && pressed === action.index) this.activate(action.index);
		}
		return action !== undefined;
	}

	/** @returns A defensive copy of the latest local geometry. */
	getGeometry(): SelectionActionBarGeometry<Value> | undefined {
		return this.geometry
			? { ...this.geometry, actions: this.geometry.actions.map((action) => ({ ...action })) }
			: undefined;
	}

	/** Clear cached geometry. */
	invalidate(): void {
		this.geometry = undefined;
	}

	/**
	 * Render the connected action surface.
	 * @param width Available terminal cells.
	 * @returns One rendered row, or no rows when all actions cannot fit.
	 */
	render(width: number): string[] {
		return this.renderRow(width, "\x1b[49m");
	}

	/**
	 * Composite the action bar over one absolute screen row without changing layout height.
	 * @param screen Current styled terminal screen.
	 * @param placement Absolute action-bar rectangle returned by {@link placeSelectionActionBar}.
	 * @returns A decorated screen copy and updated component-local hit geometry.
	 */
	composite(screen: readonly string[], placement: MouseRect): string[] {
		const result = [...screen];
		const base = result[placement.y];
		if (base === undefined) return result;
		const destination = backgroundAnsiAtColumn(base, placement.x);
		const rendered = this.renderRow(placement.width, destination)[0];
		if (!rendered) return result;
		// A narrow placement can select compact/icon mode, leaving unused cells
		// in the requested rectangle. Composite only the cells actually painted
		// by the bar so its transparent tail keeps the destination surface.
		const renderedWidth = Math.min(placement.width, visibleWidth(rendered));
		if (renderedWidth === 0) return result;
		result[placement.y] = compositeTuiLine(
			base,
			rendered,
			placement.x,
			renderedWidth,
			Math.max(visibleWidth(base), placement.x + renderedWidth),
		);
		return result;
	}

	private renderRow(width: number, destinationBackground: string): string[] {
		const bounded = Math.max(0, Math.floor(width));
		const mode = (["full", "compact", "icon"] as const).find((candidate) => this.measure(candidate) <= bounded);
		if (!mode || this.config.actions.length === 0) {
			this.geometry = undefined;
			return [];
		}
		const colors = tuiTheme(this.config.theme);
		const preferredBaseColor = colors.color("action.neutral");
		const preferredBaseBackground = colors.bgAnsi(preferredBaseColor);
		const baseColor =
			backgroundAnsiAtColumn(`${destinationBackground} `, 0) === preferredBaseBackground
				? colors.color("surface.raised")
				: preferredBaseColor;
		const baseBackground = colors.bgAnsi(baseColor);
		// Hover is a semantic surface, not the black/white contrast color of the
		// resting action background. The latter is a foreground choice and made
		// the hovered action an unreadable white-on-white block on dark themes.
		const hoverColor = colors.color("surface.hover");
		const hoverBackground = colors.bgAnsi(hoverColor);
		const labelForeground = colors.fgAnsi("text.primary");
		const iconForeground = colors.fgAnsi("text.secondary");
		const hoverForeground = colors.fgAnsi(hoverColor);
		const hoverTextForeground = colors.fgAnsi(colors.contrastBackground(hoverColor));
		const rounded = getTuiAppearance().powerline;
		const [left, right] = getTuiPillSeparators(rounded);
		const firstActive = this.hoverIndex === 0 || this.pressedIndex === 0;
		const lastIndex = this.config.actions.length - 1;
		const lastActive = this.hoverIndex === lastIndex || this.pressedIndex === lastIndex;
		const leftCapColor = firstActive ? hoverColor : baseColor;
		const rightCapColor = lastActive ? hoverColor : baseColor;
		const leftCapBackground = colors.bgAnsi(leftCapColor);
		const pieces = [`${destinationBackground}${colors.fgAnsi(leftCapColor)}${left}\x1b[39m${leftCapBackground}`];
		const actions: SelectionActionBarItemGeometry<Value>[] = [];
		let x = visibleWidth(left);
		for (const [index, action] of this.config.actions.entries()) {
			const active = index === this.hoverIndex || index === this.pressedIndex;
			const content = this.actionContent(
				action,
				mode,
				active ? hoverTextForeground : labelForeground,
				active ? hoverTextForeground : iconForeground,
			);
			const actionWidth = visibleWidth(content);
			pieces.push(active ? hoverBackground : baseBackground, content);
			actions.push({ x, y: 0, width: actionWidth, height: 1, index, value: action.value });
			x += actionWidth;
			if (index < this.config.actions.length - 1) {
				const nextActive = index + 1 === this.hoverIndex || index + 1 === this.pressedIndex;
				const divider = rounded ? (nextActive ? "" : active ? "" : "") : "│";
				pieces.push(baseBackground, active || nextActive ? hoverForeground : iconForeground, divider);
				x += visibleWidth(divider);
			}
		}
		pieces.push(destinationBackground, colors.fgAnsi(rightCapColor), right, "\x1b[39m", destinationBackground);
		this.geometry = { x: 0, y: 0, width: x + visibleWidth(right), height: 1, actions };
		return [pieces.join("")];
	}

	private measure(mode: "full" | "compact" | "icon"): number {
		const actionWidth = this.config.actions.reduce(
			(total, action) => total + visibleWidth(this.actionContent(action, mode, "", "")),
			0,
		);
		return actionWidth + Math.max(0, this.config.actions.length - 1) + 2;
	}

	private actionContent(
		action: SelectionActionBarAction<Value>,
		mode: "full" | "compact" | "icon",
		labelForeground: string,
		iconForeground: string,
	): string {
		const actionIcon = action.icon ? icon(action.icon) : "";
		const shortcut = action.shortcuts?.[0];
		const key = shortcut ? `${iconForeground}${keyHintGlyph(shortcut)}` : "";
		const parts =
			mode === "full"
				? [actionIcon ? `${iconForeground}${actionIcon} ` : "", `${labelForeground}${action.label}`, key]
				: mode === "compact"
					? [actionIcon ? `${iconForeground}${actionIcon}` : `${labelForeground}${action.label}`, key]
					: [actionIcon ? `${iconForeground}${actionIcon}` : key ? key : `${labelForeground}${action.label}`];
		return ` ${parts.filter(Boolean).join(" ")} `;
	}

	private updateHover(index: number | undefined): void {
		if (this.hoverIndex === index) return;
		this.hoverIndex = index;
		this.config.requestRender();
	}

	private activate(index: number): void {
		const action = this.config.actions[index];
		if (action) this.config.onActivate(action.value);
	}
}
