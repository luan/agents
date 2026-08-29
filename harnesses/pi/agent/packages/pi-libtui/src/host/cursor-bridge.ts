import { type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import type { TuiCursorStyle } from "../appearance.ts";
import { cursorStyle, findCursorPresentation, isNativeCursorStyle, stripCursorRoleMarkers } from "../cursor.ts";

const INSTALLATION_KEY = Symbol.for("pi-libtui/cursor-bridge/v1");
const PROTOCOL = "pi-libtui/cursor-bridge/v1" as const;
const RESET_CURSOR_SHAPE = "\x1b[0 q";

type CursorPosition = { row: number; col: number } | null;
type ExtractCursorPosition = (lines: string[], height: number) => CursorPosition;
type SetShowHardwareCursor = (enabled: boolean) => void;

interface CursorState {
	baselineVisible: boolean;
	forcingVisible: boolean;
	internalVisibilityWrite: boolean;
	shape?: TuiCursorStyle;
}

interface CursorBridgeInstallation {
	readonly protocol: typeof PROTOCOL;
	refs: number;
	readonly extract: ExtractCursorPosition;
	readonly setVisible: SetShowHardwareCursor;
	readonly states: Map<object, CursorState>;
	readonly originalExtract: ExtractCursorPosition;
	readonly originalSetVisible: SetShowHardwareCursor;
	dispose(): void;
}

// type-boundary: Pi 0.84.2 owns renderer prototypes; these checks narrow the
// cursor extraction and visibility methods before the compatibility patch.
type PiPrivateValue = unknown;

function installation(value: PiPrivateValue): CursorBridgeInstallation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<CursorBridgeInstallation>;
	return candidate.protocol === PROTOCOL &&
		typeof candidate.extract === "function" &&
		typeof candidate.setVisible === "function" &&
		candidate.states instanceof Map
		? (candidate as CursorBridgeInstallation)
		: undefined;
}

function methodOwner(value: object, property: string): object | undefined {
	let candidate: object | null = value;
	while (candidate) {
		if (Reflect.getOwnPropertyDescriptor(candidate, property)) return candidate;
		candidate = Reflect.getPrototypeOf(candidate) as object | null;
	}
	return undefined;
}

function getHardwareCursor(renderer: object): boolean {
	const read = Reflect.get(renderer, "getShowHardwareCursor") as PiPrivateValue;
	return typeof read === "function" && Reflect.apply(read, renderer, []) === true;
}

function writeTerminal(renderer: object, data: string): void {
	const terminal = Reflect.get(renderer, "terminal") as PiPrivateValue;
	if (!terminal || typeof terminal !== "object") return;
	const write = Reflect.get(terminal, "write") as PiPrivateValue;
	if (typeof write === "function") Reflect.apply(write, terminal, [data]);
}

function cursorShapeSequence(style: TuiCursorStyle): string {
	const parameter =
		style === "terminal-default"
			? 0
			: style === "blinking-block"
				? 1
				: style === "steady-block"
					? 2
					: style === "blinking-underline"
						? 3
						: style === "steady-underline"
							? 4
							: style === "blinking-bar"
								? 5
								: 6;
	return `\x1b[${parameter} q`;
}

function stateFor(bridge: CursorBridgeInstallation, renderer: object): CursorState {
	let state = bridge.states.get(renderer);
	if (state) return state;
	let previous: CursorState | undefined;
	for (const candidate of bridge.states.values()) {
		if (candidate.forcingVisible) previous = candidate;
	}
	if (previous) previous.forcingVisible = false;
	state = {
		// Pi copies effective visibility into a replacement renderer during a mode
		// switch. Carry the original preference alongside that temporary force.
		baselineVisible: previous?.baselineVisible ?? getHardwareCursor(renderer),
		forcingVisible: previous !== undefined,
		internalVisibilityWrite: false,
	};
	bridge.states.set(renderer, state);
	return state;
}

function setVisible(bridge: CursorBridgeInstallation, renderer: object, state: CursorState, enabled: boolean): void {
	state.internalVisibilityWrite = true;
	try {
		Reflect.apply(bridge.originalSetVisible, renderer, [enabled]);
	} finally {
		state.internalVisibilityWrite = false;
	}
}

function applyCursorPresentation(
	bridge: CursorBridgeInstallation,
	renderer: object,
	presentation: ReturnType<typeof findCursorPresentation>,
): void {
	const state = stateFor(bridge, renderer);
	const style = presentation
		? "style" in presentation
			? presentation.style
			: cursorStyle(presentation.role)
		: "virtual";
	if (isNativeCursorStyle(style)) {
		state.forcingVisible = true;
		setVisible(bridge, renderer, state, true);
		if (state.shape !== style) {
			writeTerminal(renderer, cursorShapeSequence(style));
			state.shape = style;
		}
		return;
	}

	if (state.forcingVisible) setVisible(bridge, renderer, state, state.baselineVisible);
	state.forcingVisible = false;
	if (state.shape !== undefined) {
		writeTerminal(renderer, RESET_CURSOR_SHAPE);
		state.shape = undefined;
	}
}

function installPrototype(prototype: object): () => void {
	const existing = installation(Reflect.get(prototype, INSTALLATION_KEY) as PiPrivateValue);
	if (existing) {
		existing.refs += 1;
		return () => existing.dispose();
	}

	const originalExtractValue = Reflect.get(prototype, "extractCursorPosition") as PiPrivateValue;
	const originalSetValue = Reflect.get(prototype, "setShowHardwareCursor") as PiPrivateValue;
	if (typeof originalExtractValue !== "function" || typeof originalSetValue !== "function") return () => {};
	const originalExtract = originalExtractValue as ExtractCursorPosition;
	const originalSetVisible = originalSetValue as SetShowHardwareCursor;
	let bridge: CursorBridgeInstallation;

	const extract: ExtractCursorPosition = function (this: object, lines, height) {
		const presentation = findCursorPresentation(lines, height);
		for (let index = 0; index < lines.length; index += 1) lines[index] = stripCursorRoleMarkers(lines[index] ?? "");
		applyCursorPresentation(bridge, this, presentation);
		return Reflect.apply(originalExtract, this, [lines, height]) as CursorPosition;
	};
	const setHardwareCursor: SetShowHardwareCursor = function (this: object, enabled) {
		const state = stateFor(bridge, this);
		if (!state.internalVisibilityWrite) state.baselineVisible = enabled;
		Reflect.apply(originalSetVisible, this, [state.forcingVisible ? true : enabled]);
	};

	bridge = {
		protocol: PROTOCOL,
		refs: 1,
		extract,
		setVisible: setHardwareCursor,
		states: new Map(),
		originalExtract,
		originalSetVisible,
		dispose() {
			this.refs -= 1;
			if (this.refs > 0) return;
			for (const [renderer, state] of this.states) {
				if (state.shape !== undefined) writeTerminal(renderer, RESET_CURSOR_SHAPE);
				setVisible(this, renderer, state, state.baselineVisible);
			}
			this.states.clear();
			if (Reflect.get(prototype, "extractCursorPosition") === this.extract) {
				Reflect.set(prototype, "extractCursorPosition", this.originalExtract);
			}
			if (Reflect.get(prototype, "setShowHardwareCursor") === this.setVisible) {
				Reflect.set(prototype, "setShowHardwareCursor", this.originalSetVisible);
			}
			Reflect.set(prototype, INSTALLATION_KEY, undefined);
		},
	};
	Reflect.set(prototype, "extractCursorPosition", extract);
	Reflect.set(prototype, "setShowHardwareCursor", setHardwareCursor);
	Reflect.set(prototype, INSTALLATION_KEY, bridge);
	return () => bridge.dispose();
}

/** Install libtui's semantic cursor bridge across Pi's renderer modes. */
export function installCursorBridge(tui: TUI): () => void {
	const prototypes = new Set<object>();
	for (const candidate of [tui as object, TuiMainScreen.prototype, TuiAltScreen.prototype]) {
		const owner = methodOwner(candidate, "extractCursorPosition");
		if (owner) prototypes.add(owner);
	}
	const disposers = [...prototypes].map(installPrototype);
	return () => {
		for (const dispose of disposers) dispose();
	};
}
