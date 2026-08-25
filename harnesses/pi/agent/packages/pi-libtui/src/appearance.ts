import { bumpTuiRenderEpoch } from "./render-epoch.ts";

/** Glyph family used to resolve every semantic icon token. */
export type TuiIconPack = "nerd-fonts" | "unicode" | "emoji";

/** Cursor presentation policy for one semantic cursor role. */
export type TuiCursorStyle =
	| "virtual"
	| "terminal-default"
	| "blinking-block"
	| "steady-block"
	| "blinking-underline"
	| "steady-underline"
	| "blinking-bar"
	| "steady-bar";

/** Process-wide rendering choices consumed by pi-libtui components. */
export interface TuiAppearanceSettings {
	iconPack: TuiIconPack;
	powerline: boolean;
	powerlineButtons: boolean;
	softCursor: boolean;
	insertionCursor: TuiCursorStyle;
	navigationCursor: TuiCursorStyle;
	selectionCursor: TuiCursorStyle;
}

/** Appearance used when no xsettings host has published an override. */
export const DEFAULT_TUI_APPEARANCE: Readonly<TuiAppearanceSettings> = Object.freeze({
	iconPack: "unicode",
	powerline: false,
	powerlineButtons: false,
	softCursor: false,
	insertionCursor: "virtual",
	navigationCursor: "virtual",
	selectionCursor: "virtual",
});

const APPEARANCE_PROTOCOL = "pi-libtui/appearance/v1" as const;
const APPEARANCE_KEY = Symbol.for(APPEARANCE_PROTOCOL);

interface AppearanceRegistry {
	readonly protocol: typeof APPEARANCE_PROTOCOL;
	configure(next: Partial<TuiAppearanceSettings>): void;
	get(): Readonly<TuiAppearanceSettings>;
	subscribe(listener: () => void): () => void;
}

// type-boundary: Symbol.for state may come from another extension realm; appearanceRegistry validates it immediately.
type UntrustedAppearanceValue = unknown;

function isIconPack(value: UntrustedAppearanceValue): value is TuiIconPack {
	return value === "nerd-fonts" || value === "unicode" || value === "emoji";
}

function isCursorStyle(value: UntrustedAppearanceValue): value is TuiCursorStyle {
	return (
		value === "virtual" ||
		value === "terminal-default" ||
		value === "blinking-block" ||
		value === "steady-block" ||
		value === "blinking-underline" ||
		value === "steady-underline" ||
		value === "blinking-bar" ||
		value === "steady-bar"
	);
}

function isAppearanceRegistry(value: UntrustedAppearanceValue): value is AppearanceRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AppearanceRegistry>;
	return (
		candidate.protocol === APPEARANCE_PROTOCOL &&
		typeof candidate.configure === "function" &&
		typeof candidate.get === "function" &&
		typeof candidate.subscribe === "function"
	);
}

function mergeAppearance(
	current: Readonly<TuiAppearanceSettings>,
	next: Partial<TuiAppearanceSettings>,
): TuiAppearanceSettings {
	return {
		iconPack: isIconPack(next.iconPack) ? next.iconPack : current.iconPack,
		powerline: typeof next.powerline === "boolean" ? next.powerline : current.powerline,
		powerlineButtons: typeof next.powerlineButtons === "boolean" ? next.powerlineButtons : current.powerlineButtons,
		softCursor: typeof next.softCursor === "boolean" ? next.softCursor : current.softCursor,
		insertionCursor: isCursorStyle(next.insertionCursor) ? next.insertionCursor : current.insertionCursor,
		navigationCursor: isCursorStyle(next.navigationCursor) ? next.navigationCursor : current.navigationCursor,
		selectionCursor: isCursorStyle(next.selectionCursor) ? next.selectionCursor : current.selectionCursor,
	};
}

function sameAppearance(left: Readonly<TuiAppearanceSettings>, right: Readonly<TuiAppearanceSettings>): boolean {
	return (
		left.iconPack === right.iconPack &&
		left.powerline === right.powerline &&
		left.powerlineButtons === right.powerlineButtons &&
		left.softCursor === right.softCursor &&
		left.insertionCursor === right.insertionCursor &&
		left.navigationCursor === right.navigationCursor &&
		left.selectionCursor === right.selectionCursor
	);
}

function appearanceRegistry(): AppearanceRegistry {
	const slots = globalThis as Record<PropertyKey, UntrustedAppearanceValue>;
	const existing = slots[APPEARANCE_KEY];
	if (isAppearanceRegistry(existing)) return existing;

	let settings = DEFAULT_TUI_APPEARANCE;
	const listeners = new Set<() => void>();
	const registry: AppearanceRegistry = {
		protocol: APPEARANCE_PROTOCOL,
		configure(next) {
			const updated = mergeAppearance(settings, next);
			if (sameAppearance(updated, settings)) return;

			settings = Object.freeze(updated);
			bumpTuiRenderEpoch();
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					// Rendering subscriptions must not prevent other components from updating.
				}
			}
		},
		get: () => settings,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	slots[APPEARANCE_KEY] = registry;
	return registry;
}

/** Merge valid fields into the process-wide appearance. */
export function configureTuiAppearance(next: Partial<TuiAppearanceSettings>): void {
	appearanceRegistry().configure(next);
}

/** Read the immutable current process-wide appearance. */
export function getTuiAppearance(): Readonly<TuiAppearanceSettings> {
	return appearanceRegistry().get();
}

/** Subscribe to effective appearance changes. */
export function subscribeTuiAppearance(listener: () => void): () => void {
	return appearanceRegistry().subscribe(listener);
}
