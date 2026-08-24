import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	isFocusable,
	type OverlayHandle,
	type OverlayOptions,
	type SizeValue,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import { resolveTuiTitle, type TuiTitleSource } from "../decoration/status.ts";
import { fitLine } from "../line-layout.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { placeAnchoredOverlay } from "./anchored.ts";

type PointerComponent = Component & { onMouse?: (event: TuiMouseEvent) => boolean };
type HeightAwareComponent = Component & { setMaxHeight?: (maxHeight: number) => void };

/** Zero-based cell used to anchor a dialog relative to its parent host. */
export interface DialogOverlayAnchor {
	/** Row in the parent host's coordinate space. */
	row: number;
	/** Column in the parent host's coordinate space. */
	col: number;
}

/** Native overlay options plus pi-libtui title and parent-anchor semantics. */
export interface DialogOverlayOptions extends Omit<OverlayOptions, "anchor" | "row" | "col"> {
	/** Optional title rendered into the top border. */
	title?: TuiTitleSource;
	/** Zero-based parent cell in the host's coordinate space. */
	parent?: DialogOverlayAnchor;
}

/** Owner that opens components as focus-owning dialogs. */
export interface DialogHost {
	/**
	 * Open a component in the host's dialog layer.
	 * @param component Child component rendered inside the dialog frame.
	 * @param options Optional sizing, visibility, title, and parent-anchor policy.
	 * @returns An idempotent function that closes this dialog.
	 */
	open(component: Component, options?: DialogOverlayOptions): () => void;
}

/**
 * Wrap a dialog host so parent-relative anchors are translated by an outer layout offset.
 * @param host Underlying host that owns the native overlay lifecycle.
 * @param offset Static offset or callback evaluated each time an anchored dialog opens.
 * @returns A host that preserves unanchored options and offsets only `parent` coordinates.
 */
export function offsetDialogHost(
	host: DialogHost,
	offset: DialogOverlayAnchor | (() => DialogOverlayAnchor),
): DialogHost {
	return {
		open(component, options = {}) {
			if (!options.parent) return host.open(component, options);
			const resolved = typeof offset === "function" ? offset() : offset;
			return host.open(component, {
				...options,
				parent: {
					row: resolved.row + options.parent.row,
					col: resolved.col + options.parent.col,
				},
			});
		},
	};
}

function border(theme: Theme, title: string, width: number): string {
	const colors = tuiTheme(theme);
	if (width <= 2) return colors.fg("border", "╭╮".slice(0, width));
	const visibleTitle = truncateToWidth(title, Math.max(0, width - 5), "");
	const label = visibleTitle ? ` ${colors.fg("accent", visibleTitle)} ` : "";
	const used = 2 + visibleWidth(label) + 1;
	return colors.fg("border", "╭─") + label + colors.fg("border", `${"─".repeat(Math.max(0, width - used))}╮`);
}

/** A bordered component suitable for Pi's native overlay stack. */
export class DialogOverlay implements Component, Focusable {
	private childWidth = 0;
	private childHeight = 0;
	private _focused = false;

	/**
	 * Create a border around an arbitrary child component.
	 * @param theme Active Pi theme used for semantic frame colors.
	 * @param child Component rendered within the one-cell frame inset.
	 * @param title Static or dynamic title resolved on each render.
	 */
	constructor(
		private readonly theme: Theme,
		private readonly child: Component,
		private readonly title: TuiTitleSource = "",
	) {}

	/** Give height-aware children the rows remaining inside this dialog's frame. */
	setMaxHeight(maxHeight: number): void {
		(this.child as HeightAwareComponent).setMaxHeight?.(Math.max(0, maxHeight - 2));
	}

	/** Whether the dialog currently owns focus. */
	get focused(): boolean {
		return this._focused;
	}

	/**
	 * Transfer focus to the dialog and to its child when the child is focusable.
	 * @param value Whether the dialog should own focus.
	 */
	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.child)) this.child.focused = value;
	}

	/**
	 * Forward raw terminal input to the child when it implements input handling.
	 * @param data Raw terminal input received by the focused dialog.
	 */
	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	/** Invalidate the child component's cached presentation state. */
	invalidate(): void {
		this.child.invalidate();
	}

	/**
	 * Translate dialog-local pointer input through the one-cell frame to the child.
	 * @param event Pointer event whose row and column are relative to this dialog.
	 * @returns The child's handled result, or `false` when the child has no pointer
	 * handler, the event is outside its last rendered bounds, or the handler throws.
	 */
	onMouse(event: TuiMouseEvent): boolean {
		const child = this.child as PointerComponent;
		if (typeof child.onMouse !== "function") return false;
		const translated = { ...event, row: event.row - 1, col: event.col - 1 };
		if (
			event.type !== "leave" &&
			(translated.row < 0 ||
				translated.row >= this.childHeight ||
				translated.col < 0 ||
				translated.col >= this.childWidth)
		)
			return false;
		try {
			return child.onMouse(translated) === true;
		} catch {
			return false;
		}
	}

	/**
	 * Render the dynamic title, child content, and one-cell border.
	 * @param width Total available columns including both border columns.
	 * @returns ANSI-styled dialog rows; widths below two columns produce one blank fitted row.
	 */
	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		if (width < 2) {
			this.childWidth = 0;
			this.childHeight = 0;
			return [fitLine("", width)];
		}
		this.childWidth = width - 2;
		const content = this.child.render(this.childWidth);
		this.childHeight = content.length;
		return [
			border(this.theme, resolveTuiTitle(this.title), width),
			...content.map(
				(line) => `${colors.fg("border", "│")}${fitLine(line, this.childWidth)}${colors.fg("border", "│")}`,
			),
			colors.fg("border", `╰${"─".repeat(this.childWidth)}╯`),
		];
	}
}

/** Opens reusable components on Pi's native, focus-owning overlay stack. */
export class DialogOverlayHost implements DialogHost {
	private readonly handles = new Set<OverlayHandle>();

	/**
	 * Create a dialog host for one TUI and semantic theme.
	 * @param tui TUI whose native overlay stack owns opened dialogs.
	 * @param theme Active Pi theme used for every dialog frame.
	 */
	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {}

	/**
	 * Open a centered or parent-anchored native overlay around a component.
	 * @param component Child component to frame and show.
	 * @param options Dialog title and native sizing/visibility options. Supplying
	 * `parent` selects bounded anchored placement; omitting it uses centered defaults.
	 * @returns An idempotent close function that hides only this overlay and requests a render.
	 */
	open(component: Component, { title, parent, ...options }: DialogOverlayOptions = {}): () => void {
		const dialog = new DialogOverlay(this.theme, component, title);
		const requestedMaxHeight = options.maxHeight ?? (parent ? undefined : "90%");
		dialog.setMaxHeight(resolveSize(requestedMaxHeight, this.tui.terminal.rows, this.tui.terminal.rows));
		const overlayOptions = parent
			? this.anchoredOptions(dialog, parent, options)
			: {
					anchor: "center" as const,
					width: 56,
					maxHeight: "90%" as const,
					margin: 1,
					...options,
				};
		const handle = this.tui.showOverlay(dialog, overlayOptions);
		this.handles.add(handle);
		this.tui.requestRender();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.handles.delete(handle);
			handle.hide();
			this.tui.requestRender();
		};
	}

	/** Hide all dialogs still owned by this host, clear their handles, and request a render. */
	dispose(): void {
		for (const handle of this.handles) handle.hide();
		this.handles.clear();
		this.tui.requestRender();
	}

	private anchoredOptions(
		dialog: DialogOverlay,
		parent: DialogOverlayAnchor,
		options: Omit<DialogOverlayOptions, "title" | "parent">,
	): OverlayOptions {
		const width = Math.min(this.tui.terminal.columns, resolveSize(options.width, this.tui.terminal.columns, 56));
		const measuredHeight = dialog.render(width).length;
		const maxHeight = resolveSize(options.maxHeight, this.tui.terminal.rows, measuredHeight);
		const placement = placeAnchoredOverlay({
			terminalCols: this.tui.terminal.columns,
			terminalRows: this.tui.terminal.rows,
			anchorRow: parent.row,
			anchorCol: parent.col,
			desiredWidth: width,
			height: Math.min(measuredHeight, maxHeight),
		});
		return {
			...placement.options,
			minWidth: options.minWidth,
			visible: options.visible,
			nonCapturing: options.nonCapturing,
		};
	}
}

function resolveSize(value: SizeValue | undefined, total: number, fallback: number): number {
	if (typeof value === "number") return Math.max(1, Math.floor(value));
	if (typeof value === "string") return Math.max(1, Math.floor((total * Number.parseFloat(value)) / 100));
	return Math.max(1, Math.floor(fallback));
}
