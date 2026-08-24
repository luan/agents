import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { getMouseRegistryState } from "../mouse/registry.ts";
import type { MouseRegistry, ScreenDecorationContext } from "../mouse.ts";
import { installMouseDispatch } from "./mouse-dispatch.ts";
import { isRecord, rendererHasOverlay, rendererHasSelection, terminalSize } from "./pi-layout-adapter.ts";
import { nativeSelectionGeometry, rendererFullscreenLayout } from "./pi-native-selection.ts";

const ALL_MOTION_INSTALLATION_KEY = Symbol.for("pi-libtui/mouse/all-motion-installation/v1");
const SCREEN_DECORATION_INSTALLATION_KEY = Symbol.for("pi-libtui/mouse/screen-decoration-installation/v1");
const ENABLE_ALL_MOTION = "\x1b[?1003h";
const DISABLE_ALL_MOTION = "\x1b[?1003l";

// type-boundary: Pi 0.84.2's private renderer patch points are narrowed by the installation validators below.
type PiPrivateValue = unknown;

type ApplySelectionHandler = (this: object, screen: string[], layout?: PiPrivateValue) => PiPrivateValue;

interface AllMotionInstallation {
	protocol: "pi-libtui/mouse/all-motion-installation/v1";
	refs: number;
	patched: (this: object) => void;
	dispose(): void;
}

interface ScreenDecorationInstallation {
	protocol: "pi-libtui/mouse/screen-decoration-installation/v1";
	refs: number;
	patched: ApplySelectionHandler;
	dispose(): void;
}

function isAllMotionInstallation(value: PiPrivateValue): value is AllMotionInstallation {
	if (!isRecord(value)) return false;
	return (
		value.protocol === "pi-libtui/mouse/all-motion-installation/v1" &&
		typeof value.refs === "number" &&
		typeof value.patched === "function" &&
		typeof value.dispose === "function"
	);
}

function isScreenDecorationInstallation(value: PiPrivateValue): value is ScreenDecorationInstallation {
	if (!isRecord(value)) return false;
	return (
		value.protocol === "pi-libtui/mouse/screen-decoration-installation/v1" &&
		typeof value.refs === "number" &&
		typeof value.patched === "function" &&
		typeof value.dispose === "function"
	);
}

export function isPiMultiplexedEnvironment(env: NodeJS.ProcessEnv): boolean {
	const term = env.TERM?.toLowerCase() ?? "";
	return (
		env.TMUX !== undefined ||
		env.ZELLIJ !== undefined ||
		env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
}

function writeTerminal(renderer: object, data: string): void {
	try {
		const terminal = Reflect.get(renderer, "terminal") as PiPrivateValue;
		if (!isRecord(terminal)) return;
		const write = terminal.write;
		if (typeof write === "function") Reflect.apply(write, terminal, [data]);
	} catch {
		// Mouse motion negotiation is best-effort.
	}
}

export function installAllMotionTracking(
	tui: TUI,
	prototype: object,
	env: NodeJS.ProcessEnv = process.env,
): () => void {
	if (!isPiMultiplexedEnvironment(env)) return () => {};
	const existing = Reflect.get(prototype, ALL_MOTION_INSTALLATION_KEY) as PiPrivateValue;
	if (isAllMotionInstallation(existing)) {
		const wasInactive = existing.refs === 0;
		existing.refs += 1;
		if (wasInactive && tui.mode === "fullscreen" && Reflect.get(tui as object, "mouseEnabled") !== false) {
			writeTerminal(tui as object, ENABLE_ALL_MOTION);
		}
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			existing.refs -= 1;
			if (existing.refs === 0) existing.dispose();
		};
	}
	const originalValue = Reflect.get(prototype, "beforeTerminalStart") as PiPrivateValue;
	if (typeof originalValue !== "function") return () => {};
	const original = originalValue as (this: object) => void;
	let installation: AllMotionInstallation;
	const patched = function (this: object): void {
		Reflect.apply(original, this, []);
		if (installation.refs > 0 && Reflect.get(this, "mouseEnabled") !== false) writeTerminal(this, ENABLE_ALL_MOTION);
	};
	let restored = false;
	installation = {
		protocol: "pi-libtui/mouse/all-motion-installation/v1",
		refs: 1,
		patched,
		dispose() {
			if (restored) return;
			if (Reflect.get(prototype, ALL_MOTION_INSTALLATION_KEY) !== installation) return;
			writeTerminal(tui as object, DISABLE_ALL_MOTION);
			if (Reflect.get(prototype, "beforeTerminalStart") !== patched) return;
			restored = true;
			Reflect.set(prototype, "beforeTerminalStart", original);
			Reflect.set(prototype, ALL_MOTION_INSTALLATION_KEY, undefined);
		},
	};
	Reflect.set(prototype, "beforeTerminalStart", patched);
	Reflect.set(prototype, ALL_MOTION_INSTALLATION_KEY, installation);
	if (tui.mode === "fullscreen" && Reflect.get(tui as object, "mouseEnabled") !== false) {
		writeTerminal(tui as object, ENABLE_ALL_MOTION);
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installation.refs -= 1;
		if (installation.refs === 0) installation.dispose();
	};
}

function isScreen(value: PiPrivateValue): value is string[] {
	return Array.isArray(value) && value.every((line) => typeof line === "string");
}

export function installScreenDecoration(prototype: object, registry: MouseRegistry): () => void {
	const existing = Reflect.get(prototype, SCREEN_DECORATION_INSTALLATION_KEY) as PiPrivateValue;
	if (isScreenDecorationInstallation(existing)) {
		existing.refs += 1;
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			existing.refs -= 1;
			if (existing.refs === 0) existing.dispose();
		};
	}
	const originalValue = Reflect.get(prototype, "applySelection") as PiPrivateValue;
	if (typeof originalValue !== "function") return () => {};
	const original = originalValue as ApplySelectionHandler;
	let installation: ScreenDecorationInstallation;
	const patched: ApplySelectionHandler = function (screen, layout) {
		const native = Reflect.apply(original, this, [screen, layout]) as PiPrivateValue;
		if (installation.refs === 0 || !isScreen(native) || getMouseRegistryState(registry).screenDecorators.length === 0)
			return native;
		const size = terminalSize(this);
		if (!size) return native;
		const fullscreenLayout = rendererFullscreenLayout(this);
		const context: ScreenDecorationContext = {
			width: size.columns,
			height: size.rows,
			hasOverlay: rendererHasOverlay(this),
			selectionActive: rendererHasSelection(this),
			selection: nativeSelectionGeometry(this),
			...(fullscreenLayout ? { viewport: fullscreenLayout.viewport, transcriptLines: fullscreenLayout.lines } : {}),
		};
		return registry.dispatchScreenDecorators(native, context);
	};
	let restored = false;
	installation = {
		protocol: "pi-libtui/mouse/screen-decoration-installation/v1",
		refs: 1,
		patched,
		dispose() {
			if (restored) return;
			if (Reflect.get(prototype, SCREEN_DECORATION_INSTALLATION_KEY) !== installation) return;
			if (Reflect.get(prototype, "applySelection") !== patched) return;
			restored = true;
			Reflect.set(prototype, "applySelection", original);
			Reflect.set(prototype, SCREEN_DECORATION_INSTALLATION_KEY, undefined);
		},
	};
	Reflect.set(prototype, "applySelection", patched);
	Reflect.set(prototype, SCREEN_DECORATION_INSTALLATION_KEY, installation);

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installation.refs -= 1;
		if (installation.refs === 0) installation.dispose();
	};
}

/** Install the generic fullscreen pointer, layout, selection, and decoration compatibility leases. */
export function installMouseBridge(tui: TUI, registry: MouseRegistry): () => void {
	const prototype = tui.mode === "fullscreen" ? Reflect.getPrototypeOf(tui as object) : TuiAltScreen.prototype;
	if (!prototype) return () => {};

	const removeAllMotion = installAllMotionTracking(tui, prototype);
	const removeScreenDecoration = installScreenDecoration(prototype, registry);
	const removeMouseDispatch = installMouseDispatch(tui, prototype, registry);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		removeMouseDispatch();
		removeAllMotion();
		removeScreenDecoration();
	};
}
