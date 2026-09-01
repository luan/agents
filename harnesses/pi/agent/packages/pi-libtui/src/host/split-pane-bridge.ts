import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	HStack,
	isFocusable,
	type TUI,
	TuiAltScreen,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";
import type { LayoutBox, MouseRect, MouseRegistry, TuiMouseEvent } from "../mouse.ts";
import { RenderedLinesCache } from "../render-cache.ts";
import type { MountedSplitPane, SplitPaneComponent, SplitPaneHost, SplitPaneRegistry } from "../split-pane.ts";
import { intersect, isComponent, rendererLayoutFrame } from "./pi-layout-adapter.ts";

const INSTALLATION_KEY = Symbol.for("pi-libtui/split-pane-bridge/v3");
const INSTALLATION_PROTOCOL = "pi-libtui/split-pane-bridge/v3" as const;

type LayoutRootSetter = (this: object, component: Component | undefined) => void;
type ImmediateRenderer = (this: object) => void;

interface RendererState {
	readonly base: Component;
	readonly definition?: MountedSplitPane;
	readonly pane?: SafeSplitPane;
	readonly wrapper?: HStack;
	suppressImmediateRender?: boolean;
}

interface SplitPaneInstallation {
	readonly protocol: typeof INSTALLATION_PROTOCOL;
	readonly version: 3;
	refs: number;
	theme: () => Theme;
	readonly registry: SplitPaneRegistry;
	readonly mouseRegistry: MouseRegistry;
	readonly original: LayoutRootSetter;
	readonly originalDescriptor: PropertyDescriptor | undefined;
	readonly patched: LayoutRootSetter;
	readonly originalImmediate: ImmediateRenderer;
	readonly originalImmediateDescriptor: PropertyDescriptor | undefined;
	readonly patchedImmediate: ImmediateRenderer;
	readonly renderers: Map<object, RendererState>;
	readonly wrapperBases: WeakMap<object, Component>;
	readonly paneSizes: Map<string, number>;
	readonly unsubscribe: () => void;
}

// type-boundary: Pi 0.84.2 renderer fields and cross-realm installation markers are narrowed before use.
type PiPrivateValue = unknown;

function isInstallation(value: PiPrivateValue): value is SplitPaneInstallation {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SplitPaneInstallation>;
	const renderers = candidate.renderers as PiPrivateValue;
	const registry = candidate.registry as PiPrivateValue;
	const mouseRegistry = candidate.mouseRegistry as PiPrivateValue;
	const wrapperBases = candidate.wrapperBases as PiPrivateValue;
	const paneSizes = candidate.paneSizes as PiPrivateValue;
	return (
		candidate.protocol === INSTALLATION_PROTOCOL &&
		candidate.version === 3 &&
		typeof candidate.refs === "number" &&
		typeof candidate.theme === "function" &&
		typeof candidate.original === "function" &&
		typeof candidate.patched === "function" &&
		typeof candidate.originalImmediate === "function" &&
		typeof candidate.patchedImmediate === "function" &&
		typeof candidate.unsubscribe === "function" &&
		!!renderers &&
		typeof renderers === "object" &&
		typeof Reflect.get(renderers, "get") === "function" &&
		typeof Reflect.get(renderers, "set") === "function" &&
		typeof Reflect.get(renderers, "delete") === "function" &&
		typeof Reflect.get(renderers, "values") === "function" &&
		!!registry &&
		typeof registry === "object" &&
		typeof Reflect.get(registry, "current") === "function" &&
		typeof Reflect.get(registry, "subscribe") === "function" &&
		!!mouseRegistry &&
		typeof mouseRegistry === "object" &&
		typeof Reflect.get(mouseRegistry, "registerOverlayRegion") === "function" &&
		!!wrapperBases &&
		typeof wrapperBases === "object" &&
		typeof Reflect.get(wrapperBases, "get") === "function" &&
		typeof Reflect.get(wrapperBases, "set") === "function" &&
		!!paneSizes &&
		typeof paneSizes === "object" &&
		typeof Reflect.get(paneSizes, "get") === "function" &&
		typeof Reflect.get(paneSizes, "set") === "function"
	);
}

function originalMethod<T extends LayoutRootSetter | ImmediateRenderer>(
	prototype: object,
	name: "setLayoutRoot" | "requestImmediateRender",
): { descriptor: PropertyDescriptor | undefined; method: T } | undefined {
	const value = Reflect.get(prototype, name) as PiPrivateValue;
	if (typeof value !== "function") return undefined;
	return {
		descriptor: Object.getOwnPropertyDescriptor(prototype, name),
		method: value as T,
	};
}

function installMethod(
	prototype: object,
	name: "setLayoutRoot" | "requestImmediateRender",
	method: LayoutRootSetter | ImmediateRenderer,
): void {
	Object.defineProperty(prototype, name, {
		configurable: true,
		writable: true,
		value: method,
	});
}

function restoreMethod(
	prototype: object,
	name: "setLayoutRoot" | "requestImmediateRender",
	descriptor: PropertyDescriptor | undefined,
	patched: LayoutRootSetter | ImmediateRenderer,
): void {
	if (Reflect.get(prototype, name) !== patched) return;
	if (descriptor) Object.defineProperty(prototype, name, descriptor);
	else Reflect.deleteProperty(prototype, name);
}

function focusedComponent(renderer: object): Component | null | undefined {
	try {
		const method = Reflect.get(renderer, "getFocusedComponent") as PiPrivateValue;
		if (typeof method !== "function") return undefined;
		const focused = Reflect.apply(method, renderer, []) as PiPrivateValue;
		return focused === null || isComponent(focused) ? focused : undefined;
	} catch {
		return undefined;
	}
}

function setRendererFocus(renderer: object, component: Component | null): boolean {
	try {
		const method = Reflect.get(renderer, "setFocus") as PiPrivateValue;
		if (typeof method !== "function") return false;
		Reflect.apply(method, renderer, [component]);
		return focusedComponent(renderer) === component;
	} catch {
		return false;
	}
}

class SafeSplitPane extends VStack implements Focusable {
	private readonly child: SplitPaneComponent | undefined;
	private readonly removeMainFocusRegion: () => void;
	private readonly removePaneFocusRegion: () => void;
	private _focused = false;
	private restoreFocus: Component | null | undefined;
	private readonly renderCache = new RenderedLinesCache();

	constructor(
		private readonly renderer: object,
		theme: Theme,
		factory: MountedSplitPane["component"],
		private readonly base: Component,
		mouseRegistry: MouseRegistry,
		private readonly suppressNextImmediateRender: () => void,
	) {
		super();
		const host: SplitPaneHost = {
			tui: renderer as TUI,
			getTerminalSize: () => ({ columns: rendererColumns(renderer), rows: this.viewportRows() }),
			requestRender: () => {
				this.renderCache.clear();
				requestRender(renderer);
			},
			focus: () => this.focus(),
			blur: () => this.blur(),
			isFocused: () => this.isFocused(),
		};
		try {
			this.child = factory(host, theme);
		} catch {
			this.child = undefined;
		}
		if (this.child) this.addChild(this.child, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
		this.removeMainFocusRegion = mouseRegistry.registerOverlayRegion({
			id: "pi-libtui.split-pane.main-focus",
			priority: Number.MAX_SAFE_INTEGER,
			getRect: () => this.mainRect(),
			onMouse: (event) => {
				if (event.type === "press" && event.button === 0) this.blur();
				// This is a focus prepass. Pi and components still own the click.
				return false;
			},
		});
		this.removePaneFocusRegion = mouseRegistry.registerOverlayRegion({
			id: "pi-libtui.split-pane.pane-focus",
			priority: Number.MAX_SAFE_INTEGER,
			getRect: () => componentRect(this.renderer, this),
			onMouse: (event) => {
				if (event.type === "press" && event.button === 0) this.focus();
				// The contributed component still owns the click itself.
				return false;
			},
		});
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		if (this._focused !== value) this.renderCache.clear();
		this._focused = value;
		try {
			if (this.child && isFocusable(this.child)) this.child.focused = value;
		} catch {
			// A contributed focus setter must not break the renderer.
		}
	}

	get wantsKeyRelease(): boolean {
		return this.child?.wantsKeyRelease === true;
	}

	handleInput(data: string): void {
		this.renderCache.clear();
		let deferred = false;
		try {
			deferred = this.child?.defersInputRender?.(data) === true;
		} catch {
			// Input rendering hints are optional; forwarding remains authoritative.
		}
		try {
			this.child?.handleInput?.(data);
			if (deferred) this.suppressNextImmediateRender();
		} catch {
			// A contributed input handler must not break terminal dispatch.
		}
	}

	onMouse(event: TuiMouseEvent): boolean {
		try {
			const handled = this.child?.onMouse?.(event) === true;
			if (handled) this.renderCache.clear();
			return handled;
		} catch {
			return false;
		}
	}

	focus(): void {
		if (this.isFocused()) return;
		if (this.child?.acceptsFocus?.() === false) return;
		const previous = focusedComponent(this.renderer);
		if (previous === undefined) return;
		this.restoreFocus = previous;
		if (!setRendererFocus(this.renderer, this)) this.restoreFocus = undefined;
	}

	blur(): void {
		if (!this.isFocused()) return;
		const target = this.restoreFocus ?? null;
		if (setRendererFocus(this.renderer, target)) this.restoreFocus = undefined;
	}

	isFocused(): boolean {
		return focusedComponent(this.renderer) === this;
	}

	transferFocusFrom(previous: SafeSplitPane): void {
		if (focusedComponent(this.renderer) !== previous) return;
		this.restoreFocus = previous.restoreFocus;
		if (!setRendererFocus(this.renderer, this)) this.restoreFocus = undefined;
	}

	render(width: number): string[] {
		const rows = this.viewportRows();
		return this.renderCache.get(width, `${rows}`, () => {
			try {
				const lines = this.child?.render(width) ?? [];
				if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return [];
				const bounded = lines.slice(0, rows);
				return this.child?.rendersWithinWidth === true
					? bounded
					: bounded.map((line) => truncateToWidth(line, width, ""));
			} catch {
				return [];
			}
		});
	}

	invalidate(): void {
		this.renderCache.clear();
		try {
			this.child?.invalidate();
		} catch {
			// A contributed pane must not break host invalidation.
		}
	}

	dispose(): void {
		this.removePaneFocusRegion();
		this.removeMainFocusRegion();
		this.blur();
		try {
			this.child?.dispose?.();
		} catch {
			// Cleanup is best effort across optional extension realms.
		}
	}

	private viewportRows(): number {
		return componentRect(this.renderer, this)?.height ?? rendererRows(this.renderer);
	}

	private mainRect(): MouseRect | undefined {
		return componentRect(this.renderer, this.base);
	}
}

function componentRect(renderer: object, component: Component): MouseRect | undefined {
	const frame = rendererLayoutFrame(renderer);
	if (!frame) return undefined;
	let result: MouseRect | undefined;
	const visit = (box: LayoutBox): void => {
		if (result) return;
		if (box.component === component) {
			const visible = intersect(box.rect, box.clip);
			if (visible.width > 0 && visible.height > 0) result = visible;
			return;
		}
		for (const child of box.children) visit(child);
	};
	visit(frame.root);
	return result;
}

class SplitSpacer implements Component {
	constructor(private readonly maxRows: () => number) {}

	render(width: number): string[] {
		return Array.from({ length: Math.max(0, this.maxRows()) }, () => " ".repeat(Math.max(0, width)));
	}

	invalidate(): void {}
}

class SplitDivider implements Component {
	private hovered = false;
	private dragging = false;
	private resize: (screenColumn: number, committed: boolean) => void = () => {};

	constructor(
		private readonly theme: Theme,
		private readonly maxRows: () => number,
		private readonly repaint: () => void,
	) {}

	setResize(resize: (screenColumn: number, committed: boolean) => void): void {
		this.resize = resize;
	}

	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		const border = colors.fg(this.hovered || this.dragging ? "accent" : "border", "│");
		const line = `${border}${" ".repeat(Math.max(0, width - 1))}`;
		return Array.from({ length: Math.max(0, this.maxRows()) }, () => line);
	}

	invalidate(): void {}

	onMouse(event: TuiMouseEvent): boolean {
		if (event.type === "press") {
			if (event.button !== 0) return false;
			this.dragging = true;
			this.setHovered(true);
			this.resize(event.screenCol, false);
			return true;
		}
		if (event.type === "drag" && this.dragging) {
			this.resize(event.screenCol, false);
			return true;
		}
		if (event.type === "release" && this.dragging) {
			this.dragging = false;
			this.resize(event.screenCol, true);
			this.setHovered(false);
			return true;
		}
		if (event.type === "enter" || event.type === "move") {
			this.setHovered(true);
			return true;
		}
		if (event.type === "leave") {
			this.setHovered(false);
			return true;
		}
		return false;
	}

	private setHovered(hovered: boolean): void {
		if (this.hovered === hovered) return;
		this.hovered = hovered;
		this.repaint();
	}
}

class ResizableSplitLayout extends HStack {
	private preferredSize: number;

	constructor(
		base: Component,
		pane: SafeSplitPane,
		private readonly definition: MountedSplitPane,
		private readonly terminalColumns: () => number,
		private readonly repaint: () => void,
		preferredSize: number,
		onResize: (size: number) => void,
		maxRows: () => number,
		theme: Theme,
	) {
		const divider = new SplitDivider(theme, maxRows, repaint);
		let syncSize = (_width: number): void => {};
		const visible = ({ width }: { width: number }) => {
			syncSize(width);
			return width >= definition.minMainSize + definition.gap + 2;
		};
		const main = { component: base, basis: 0, grow: 1, shrink: 1, minSize: definition.minMainSize } as const;
		const auxiliary = {
			component: pane,
			basis: definition.size,
			grow: 0,
			shrink: 0,
			minSize: definition.size,
			maxSize: definition.size,
			visible,
		};
		const separator = {
			component: divider,
			basis: 1,
			grow: 0,
			shrink: 0,
			minSize: 1,
			maxSize: 1,
			visible,
		} as const;
		const spacer = {
			component: new SplitSpacer(maxRows),
			basis: definition.gap,
			grow: 0,
			shrink: 0,
			minSize: definition.gap,
			maxSize: definition.gap,
			visible,
		} as const;
		const split =
			definition.position === "left" ? [auxiliary, separator, spacer, main] : [main, spacer, separator, auxiliary];
		super(split, { align: "stretch" });
		this.preferredSize = preferredSize;
		syncSize = (width) => this.applyEffectiveSize(width);
		this.applyEffectiveSize(this.terminalColumns());
		divider.setResize((screenColumn, committed) => {
			const raw = definition.position === "left" ? screenColumn : this.terminalColumns() - screenColumn - 1;
			const size = this.clampPreferred(raw);
			if (size !== this.preferredSize) {
				this.preferredSize = size;
				onResize(size);
				this.applyEffectiveSize(this.terminalColumns());
				this.repaint();
			}
			if (committed) definition.onResize?.(size);
		});
	}

	private applyEffectiveSize(width: number): void {
		const size = this.effectiveSize(width);
		for (const entry of this.entries) {
			if (entry.component instanceof SafeSplitPane) {
				entry.basis = size;
				entry.minSize = size;
				entry.maxSize = size;
			}
		}
	}

	private clampPreferred(size: number): number {
		const available = this.terminalColumns() - this.definition.minMainSize - this.definition.gap - 1;
		return Math.max(1, Math.min(available, Math.floor(size)));
	}

	private effectiveSize(width: number): number {
		const available = width - this.definition.minMainSize - this.definition.gap - 1;
		return Math.max(1, Math.min(this.preferredSize, available));
	}
}

function rendererRoot(renderer: object): Component | undefined {
	const root = Reflect.get(renderer, "layoutRoot") as PiPrivateValue;
	return isComponent(root) ? root : undefined;
}

function rendererRows(renderer: object): number {
	const terminal = Reflect.get(renderer, "terminal") as PiPrivateValue;
	if (!terminal || typeof terminal !== "object") return 0;
	const rows = Reflect.get(terminal, "rows") as PiPrivateValue;
	return typeof rows === "number" && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
}

function rendererColumns(renderer: object): number {
	const terminal = Reflect.get(renderer, "terminal") as PiPrivateValue;
	if (!terminal || typeof terminal !== "object") return 0;
	const columns = Reflect.get(terminal, "columns") as PiPrivateValue;
	return typeof columns === "number" && Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

function requestRender(renderer: object): void {
	try {
		const method = Reflect.get(renderer, "requestRender") as PiPrivateValue;
		if (typeof method === "function") Reflect.apply(method, renderer, []);
	} catch {
		// A stale optional pane host must not break the renderer.
	}
}

function requestLayoutRender(renderer: object): void {
	try {
		Reflect.set(renderer, "currentLayout", undefined);
	} catch {
		// A renderer without Pi's structural layout cache can still repaint normally.
	}
	requestRender(renderer);
}

function disposePane(state: RendererState | undefined): void {
	state?.pane?.dispose();
}

function buildWrapper(
	installation: SplitPaneInstallation,
	renderer: object,
	base: Component,
	definition: MountedSplitPane,
	theme: Theme,
	mouseRegistry: MouseRegistry,
): { pane: SafeSplitPane; wrapper: HStack } {
	const pane = new SafeSplitPane(renderer, theme, definition.component, base, mouseRegistry, () => {
		const state = installation.renderers.get(renderer);
		if (!state || state.pane !== pane) return;
		state.suppressImmediateRender = true;
		queueMicrotask(() => {
			if (state.suppressImmediateRender) state.suppressImmediateRender = false;
		});
	});
	const wrapper = new ResizableSplitLayout(
		base,
		pane,
		definition,
		() => rendererColumns(renderer),
		() => requestLayoutRender(renderer),
		installation.paneSizes.get(definition.id) ??
			(definition.initialRatio === undefined
				? definition.size
				: Math.max(1, Math.floor(rendererColumns(renderer) * definition.initialRatio))),
		(size) => installation.paneSizes.set(definition.id, size),
		() => componentRect(renderer, pane)?.height ?? rendererRows(renderer),
		theme,
	);
	return { pane, wrapper };
}

function applyRoot(installation: SplitPaneInstallation, renderer: object, component: Component | undefined): void {
	if (!component) {
		Reflect.apply(installation.original, renderer, [undefined]);
		const previous = installation.renderers.get(renderer);
		installation.renderers.delete(renderer);
		disposePane(previous);
		return;
	}

	const base = installation.wrapperBases.get(component as object) ?? component;
	const previous = installation.renderers.get(renderer);
	const definition = installation.registry.current();
	if (!definition) {
		Reflect.apply(installation.original, renderer, [base]);
		installation.renderers.set(renderer, { base });
		disposePane(previous);
		return;
	}
	if (previous?.base === base && previous.definition === definition && previous.wrapper) {
		Reflect.apply(installation.original, renderer, [previous.wrapper]);
		return;
	}

	const { pane, wrapper } = buildWrapper(
		installation,
		renderer,
		base,
		definition,
		installation.theme(),
		installation.mouseRegistry,
	);
	try {
		Reflect.apply(installation.original, renderer, [wrapper]);
	} catch (error) {
		pane.dispose();
		throw error;
	}
	for (const [owner, state] of installation.renderers) {
		if (owner !== renderer && state.pane) pane.transferFocusFrom(state.pane);
	}
	installation.wrapperBases.set(wrapper, base);
	installation.renderers.set(renderer, { base, definition, pane, wrapper });
	disposePane(previous);
}

function refresh(installation: SplitPaneInstallation, prototype: object): void {
	if (Reflect.get(prototype, "setLayoutRoot") !== installation.patched) return;
	for (const [renderer, state] of installation.renderers) applyRoot(installation, renderer, state.base);
}

function ensureCurrentRoot(installation: SplitPaneInstallation, tui: TUI): void {
	const current = rendererRoot(tui as object);
	if (!current) return;
	const setter = Reflect.get(tui as object, "setLayoutRoot") as PiPrivateValue;
	if (typeof setter !== "function") return;
	// Pi gives extension widgets a stable proxy. Calling its method makes the
	// patched setter receive the active renderer as `this`, not the proxy.
	Reflect.apply(setter, tui, [installation.wrapperBases.get(current as object) ?? current]);
}

function releaseBridge(prototype: object, installation: SplitPaneInstallation): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installation.refs -= 1;
		if (installation.refs > 0) return;
		installation.unsubscribe();
		for (const [renderer, state] of installation.renderers) {
			if (state.wrapper && rendererRoot(renderer) === state.wrapper) {
				Reflect.apply(installation.original, renderer, [state.base]);
			}
			disposePane(state);
		}
		installation.renderers.clear();
		restoreMethod(prototype, "setLayoutRoot", installation.originalDescriptor, installation.patched);
		restoreMethod(
			prototype,
			"requestImmediateRender",
			installation.originalImmediateDescriptor,
			installation.patchedImmediate,
		);
		if (Reflect.get(prototype, INSTALLATION_KEY) === installation) Reflect.deleteProperty(prototype, INSTALLATION_KEY);
	};
}

/** Install the fullscreen layout-root bridge used by split-pane contributions. */
export function installSplitPaneBridge(
	tui: TUI,
	theme: () => Theme,
	registry: SplitPaneRegistry,
	mouseRegistry: MouseRegistry,
): () => void {
	const prototype = tui.mode === "fullscreen" ? Reflect.getPrototypeOf(tui as object) : TuiAltScreen.prototype;
	if (!prototype) return () => {};
	const active = Reflect.get(prototype, INSTALLATION_KEY) as PiPrivateValue;
	if (isInstallation(active)) {
		if (
			Reflect.get(prototype, "setLayoutRoot") !== active.patched ||
			Reflect.get(prototype, "requestImmediateRender") !== active.patchedImmediate
		)
			return () => {};
		active.refs += 1;
		active.theme = theme;
		ensureCurrentRoot(active, tui);
		return releaseBridge(prototype, active);
	}

	const original = originalMethod<LayoutRootSetter>(prototype, "setLayoutRoot");
	const originalImmediate = originalMethod<ImmediateRenderer>(prototype, "requestImmediateRender");
	if (!original || !originalImmediate) return () => {};
	let installation!: SplitPaneInstallation;
	const patched: LayoutRootSetter = function (component) {
		if (installation.refs <= 0) Reflect.apply(installation.original, this, [component]);
		else applyRoot(installation, this, component);
	};
	const patchedImmediate: ImmediateRenderer = function () {
		const state = installation.renderers.get(this);
		if (installation.refs > 0 && state?.suppressImmediateRender) {
			state.suppressImmediateRender = false;
			return;
		}
		Reflect.apply(installation.originalImmediate, this, []);
	};
	installation = {
		protocol: INSTALLATION_PROTOCOL,
		version: 3,
		refs: 1,
		theme,
		registry,
		mouseRegistry,
		original: original.method,
		originalDescriptor: original.descriptor,
		patched,
		originalImmediate: originalImmediate.method,
		originalImmediateDescriptor: originalImmediate.descriptor,
		patchedImmediate,
		renderers: new Map(),
		wrapperBases: new WeakMap(),
		paneSizes: new Map(),
		unsubscribe: registry.subscribe(() => refresh(installation, prototype)),
	};
	Object.defineProperty(prototype, INSTALLATION_KEY, { configurable: true, value: installation });
	installMethod(prototype, "setLayoutRoot", patched);
	installMethod(prototype, "requestImmediateRender", patchedImmediate);
	ensureCurrentRoot(installation, tui);
	return releaseBridge(prototype, installation);
}
