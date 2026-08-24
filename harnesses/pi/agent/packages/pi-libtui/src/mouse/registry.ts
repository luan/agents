import type { NativeSelectionGeometry } from "../selection.ts";
import type { MouseRect, TuiMouseEvent } from "./events.ts";

export const MOUSE_REGISTRY_KEY = Symbol.for("pi-libtui/mouse/registry/v1");
export const MOUSE_PROTOCOL = "pi-libtui/mouse/registry/v1" as const;

/** The visible primary viewport and its logical vertical scroll offset. */
export interface ViewportRect extends MouseRect {
	/** Zero-based logical row at the top of the viewport. */
	scrollTop: number;
}

/** Terminal and renderer state supplied to screen decorators. */
export interface ScreenDecorationContext {
	/** Current terminal width in cells. */
	width: number;
	/** Current terminal height in rows. */
	height: number;
	/** Whether Pi currently has a visible overlay. */
	hasOverlay: boolean;
	/** Native Pi selection is already painted into the screen. */
	selectionActive?: boolean;
	/** Current native selection geometry recomputed from Pi's latest layout. */
	selection?: NativeSelectionGeometry;
	/** Visible primary viewport when Pi exposes its layout and scroll state. */
	viewport?: ViewportRect;
	/** Current logical transcript rows before viewport clipping, when Pi exposes its fullscreen layout. */
	transcriptLines?: readonly string[];
}

/** A viewport input transformation, optionally consuming the resulting input. */
export type ViewportInputHandlerResult = { consume?: boolean; data?: string } | undefined;
/** Returns whether native copy handling should be deferred for the current selection release. */
export type NativeCopyDeferrer = () => boolean;

/** Options for one ordered viewport input handler. */
export interface ViewportInputHandlerRegistration {
	/** Stable diagnostic identity for the handler. Registrations are removed by object identity. */
	id: string;
	/** Dispatch priority. Higher values run first; equal priorities run newest first. Defaults to zero. */
	priority?: number;
	/**
	 * Inspects or transforms viewport input.
	 *
	 * @param data Current input after transformations from earlier handlers.
	 * @returns A replacement `data`, a `consume` decision, both, or undefined to pass through unchanged.
	 */
	handle(data: string): ViewportInputHandlerResult;
}

/** Options for one ordered fullscreen screen decorator. */
export interface ScreenDecoratorRegistration {
	/** Stable diagnostic identity for the decorator. Registrations are removed by object identity. */
	id: string;
	/** Dispatch priority. Higher values run first; equal priorities run newest first. Defaults to zero. */
	priority?: number;
	/**
	 * Decorates the current rendered screen.
	 *
	 * @param screen Current screen after earlier decorators have run.
	 * @param context Current terminal, overlay, selection, and viewport state.
	 * @returns The complete screen to pass to the next decorator.
	 */
	decorate(screen: string[], context: ScreenDecorationContext): string[];
}

/** Options for a screen-positioned pointer target outside Pi's component layout. */
export interface OverlayMouseRegion {
	/** Stable diagnostic identity for the region. Registrations are removed by object identity. */
	id: string;
	/** Higher priorities are hit first. Equal priorities use latest registration first. */
	priority?: number;
	/** Resolve on every event because Pi can move or resize an overlay. */
	getRect(): MouseRect | undefined;
	/**
	 * Handles an event whose `row` and `col` are relative to the latest resolved rectangle.
	 *
	 * @param event Normalized pointer event for this region.
	 * @returns `true` when the region handled the event and dispatch should stop.
	 */
	onMouse(event: TuiMouseEvent): boolean;
}

/** Versioned cross-extension registry for pointer, input, copy, and screen-decoration hooks. */
export interface MouseRegistry {
	/** Protocol identity used to validate a registry shared through `globalThis`. */
	readonly protocol: typeof MOUSE_PROTOCOL;
	/** Public registry API version. */
	readonly version: 1;
	/**
	 * Registers a dynamic screen-positioned pointer target.
	 *
	 * @param region Region definition to register.
	 * @returns An idempotent function that removes this exact registration object.
	 */
	registerOverlayRegion(region: OverlayMouseRegion): () => void;
	/**
	 * Registers an ordered viewport input handler.
	 *
	 * @param handler Handler definition to register.
	 * @returns An idempotent function that removes this exact registration object.
	 */
	registerViewportInputHandler(handler: ViewportInputHandlerRegistration): () => void;
	/**
	 * Runs viewport input through registered handlers until one consumes it.
	 * Handler failures are ignored so optional extensions cannot break input.
	 *
	 * @param data Raw viewport input to dispatch.
	 * @returns The final transformed data and whether a handler consumed it.
	 */
	dispatchViewportInput(data: string): { data: string; consumed: boolean };
	/**
	 * Registers a predicate that can defer Pi's native copy handling.
	 *
	 * @param deferrer Predicate evaluated during native selection release.
	 * @returns An idempotent function that removes this exact predicate.
	 */
	registerNativeCopyDeferrer(deferrer: NativeCopyDeferrer): () => void;
	/**
	 * Evaluates registered copy deferrers until one returns true.
	 * Predicate failures are ignored.
	 *
	 * @returns `true` when native copy should be deferred; otherwise `false`.
	 */
	shouldDeferNativeCopy(): boolean;
	/**
	 * Registers an ordered fullscreen screen decorator.
	 *
	 * @param decorator Decorator definition to register.
	 * @returns An idempotent function that removes this exact registration object.
	 */
	registerScreenDecorator(decorator: ScreenDecoratorRegistration): () => void;
	/**
	 * Composes registered decorators over a rendered screen.
	 * Throwing decorators and invalid non-string-array results are ignored.
	 *
	 * @param screen Initial rendered screen.
	 * @param context Current terminal and renderer state.
	 * @returns The final valid decorated screen, or the last valid screen when a decorator fails.
	 */
	dispatchScreenDecorators(screen: string[], context: ScreenDecorationContext): string[];
	/** Ask the active fullscreen bridge to keep the primary viewport anchored for the next resize. */
	preserveViewportOnResize?(): void;
}

/** Shared registration storage used by the mouse bridge for direct overlay dispatch. */
export interface MouseRegistryState {
	/** Registered overlay regions in registration order. */
	readonly regions: OverlayMouseRegion[];
	/** Registered viewport input handlers in registration order. */
	readonly viewportInputHandlers: ViewportInputHandlerRegistration[];
	/** Registered native-copy predicates in registration order. */
	readonly nativeCopyDeferrers: NativeCopyDeferrer[];
	/** Registered screen decorators in registration order. */
	readonly screenDecorators: ScreenDecoratorRegistration[];
	viewportPreserver?: () => void;
}

const STATE_KEY = Symbol.for("pi-libtui/mouse/registry-state/v1");
const states = new WeakMap<MouseRegistry, MouseRegistryState>();

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the public methods.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is MouseRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<MouseRegistry>;
	return (
		candidate.protocol === MOUSE_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.registerOverlayRegion === "function" &&
		typeof candidate.registerViewportInputHandler === "function" &&
		typeof candidate.dispatchViewportInput === "function" &&
		typeof candidate.registerNativeCopyDeferrer === "function" &&
		typeof candidate.shouldDeferNativeCopy === "function" &&
		typeof candidate.registerScreenDecorator === "function" &&
		typeof candidate.dispatchScreenDecorators === "function"
	);
}

function stateFor(registry: MouseRegistry): MouseRegistryState {
	const existing = states.get(registry);
	if (existing) return existing;
	const shared = Reflect.get(registry as object, STATE_KEY) as UntrustedRegistryValue;
	if (isState(shared)) {
		states.set(registry, shared);
		return shared;
	}
	const state: MouseRegistryState = {
		regions: [],
		viewportInputHandlers: [],
		nativeCopyDeferrers: [],
		screenDecorators: [],
	};
	Object.defineProperty(registry, STATE_KEY, {
		value: state,
		enumerable: false,
		configurable: false,
	});
	states.set(registry, state);
	return state;
}

function isState(value: UntrustedRegistryValue): value is MouseRegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<MouseRegistryState>;
	return (
		Array.isArray(candidate.regions) &&
		Array.isArray(candidate.viewportInputHandlers) &&
		Array.isArray(candidate.nativeCopyDeferrers) &&
		Array.isArray(candidate.screenDecorators)
	);
}

/**
 * Returns the shared registration state associated with a mouse registry.
 *
 * @param registry Registry whose state should be resolved.
 * @returns The stable state object shared across compatible extension realms.
 */
export function getMouseRegistryState(registry: MouseRegistry): MouseRegistryState {
	return stateFor(registry);
}

function removeIdentity<T>(values: T[], value: T): void {
	const index = values.indexOf(value);
	if (index >= 0) values.splice(index, 1);
}

function prioritized<T extends { priority?: number }>(values: readonly T[]): T[] {
	return values
		.map((value, order) => ({ value, order }))
		.sort((left, right) => (right.value.priority ?? 0) - (left.value.priority ?? 0) || right.order - left.order)
		.map(({ value }) => value);
}

/**
 * Resolves or creates the process-wide version-one mouse registry.
 *
 * Compatible registries already published under {@link MOUSE_REGISTRY_KEY} are reused so
 * independently loaded extensions share registrations without runtime dependencies.
 *
 * @param scope Global object that owns the registry capability. Defaults to `globalThis`.
 * @returns The existing compatible registry, or a newly installed version-one registry.
 */
export function ensureMouseRegistry(scope: typeof globalThis = globalThis): MouseRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[MOUSE_REGISTRY_KEY];
	if (isRegistry(existing)) {
		stateFor(existing);
		return existing;
	}
	const registry: MouseRegistry = {
		protocol: MOUSE_PROTOCOL,
		version: 1,
		registerOverlayRegion(region) {
			const state = stateFor(registry);
			state.regions.push(region);
			return () => removeIdentity(state.regions, region);
		},
		registerViewportInputHandler(handler) {
			const state = stateFor(registry);
			state.viewportInputHandlers.push(handler);
			return () => removeIdentity(state.viewportInputHandlers, handler);
		},
		dispatchViewportInput(data) {
			let current = data;
			for (const handler of prioritized(stateFor(registry).viewportInputHandlers)) {
				let result: ViewportInputHandlerResult;
				try {
					result = handler.handle(current);
				} catch {
					continue;
				}
				if (typeof result?.data === "string") current = result.data;
				if (result?.consume === true) return { data: current, consumed: true };
			}
			return { data: current, consumed: false };
		},
		registerNativeCopyDeferrer(deferrer) {
			const state = stateFor(registry);
			state.nativeCopyDeferrers.push(deferrer);
			return () => removeIdentity(state.nativeCopyDeferrers, deferrer);
		},
		shouldDeferNativeCopy() {
			for (const deferrer of [...stateFor(registry).nativeCopyDeferrers]) {
				try {
					if (deferrer()) return true;
				} catch {
					// Optional predicates must not affect native copy behavior.
				}
			}
			return false;
		},
		registerScreenDecorator(decorator) {
			const state = stateFor(registry);
			state.screenDecorators.push(decorator);
			return () => removeIdentity(state.screenDecorators, decorator);
		},
		dispatchScreenDecorators(screen, context) {
			let current = screen;
			for (const decorator of prioritized(stateFor(registry).screenDecorators)) {
				try {
					const decorated = decorator.decorate(current, context);
					if (Array.isArray(decorated) && decorated.every((line) => typeof line === "string")) current = decorated;
				} catch {
					// Optional decorators must not break fullscreen rendering.
				}
			}
			return current;
		},
		preserveViewportOnResize() {
			try {
				stateFor(registry).viewportPreserver?.();
			} catch {
				// The fullscreen bridge is optional and must not break tool interaction.
			}
		},
	};
	stateFor(registry);
	slots[MOUSE_REGISTRY_KEY] = registry;
	return registry;
}

/** Preserve the host transcript viewport across an expansion resize when a bridge is installed. */
export function preserveViewportOnResize(scope: typeof globalThis = globalThis): void {
	ensureMouseRegistry(scope).preserveViewportOnResize?.();
}

/** Options for blocking transcript selection behind a modal pointer surface. */
export interface ModalPointerShieldOptions {
	/** Stable diagnostic identity for the registered region. */
	id: string;
	/** Current screen bounds covered by the modal surface. */
	getRect(): MouseRect | undefined;
	/** Hit priority below the modal's own region; defaults to 9999. */
	priority?: number;
}

/** Consume pointer gestures behind a modal overlay before Pi can begin transcript selection. */
export function registerModalPointerShield(registry: MouseRegistry, options: ModalPointerShieldOptions): () => void {
	return registry.registerOverlayRegion({
		id: options.id,
		priority: options.priority ?? 9_999,
		getRect: options.getRect,
		onMouse: (event) => event.type === "press" || event.type === "drag" || event.type === "release",
	});
}
