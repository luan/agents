import { bumpTuiRenderEpoch } from "./render-epoch.ts";

/** Glyph family used to resolve every semantic icon token. */
export type TuiIconPack = "nerd-fonts" | "unicode" | "emoji";

/** Compact marker used by shared activity indicators. */
export type TuiActivityMarkerStyle =
	| "off"
	| "spinner"
	| "pulse"
	| "static"
	| "line"
	| "arc"
	| "pipe"
	| "grow-vertical"
	| "grow-horizontal"
	| "triangle"
	| "circle-quarters"
	| "circle-halves"
	| "bracket-spin"
	| "dots"
	| "quadrants"
	| "sparkle"
	| "braille-wave"
	| "braille-dna"
	| "braille-scan"
	| "braille-rain"
	| "braille-scanline"
	| "braille-pulse"
	| "braille-sparkle"
	| "braille-cascade"
	| "braille-columns"
	| "braille-orbit"
	| "braille-breathe"
	| "braille-wave-rows"
	| "braille-checkerboard"
	| "braille-helix"
	| "scanline"
	| "snake"
	| "fill-sweep"
	| "diagonal-swipe"
	| "dna"
	| "radar"
	| "bounce"
	| "orbit"
	| "conveyor"
	| "heartbeat"
	| "nerd-progress"
	| "nerd-morph"
	| "nerd-pipeline"
	| "nerd-pi-orbit";

/** Stable marker catalog for settings hosts and feature-owned overrides. */
export const TUI_ACTIVITY_MARKER_OPTIONS = Object.freeze([
	{ value: "off", label: "Off", description: "Do not show an activity marker." },
	{ value: "spinner", label: "Spinner", description: "Rotate a compact Braille spinner." },
	{ value: "pulse", label: "Pulse", description: "Pulse a fixed activity dot." },
	{ value: "static", label: "Static", description: "Show a fixed activity dot." },
	{ value: "line", label: "Line", description: "Rotate a compact ASCII line." },
	{ value: "arc", label: "Arc", description: "Rotate through rounded Unicode arc positions." },
	{ value: "pipe", label: "Pipe", description: "Rotate through box-drawing junctions." },
	{ value: "grow-vertical", label: "Vertical grow", description: "Grow and contract a vertical block." },
	{ value: "grow-horizontal", label: "Horizontal grow", description: "Grow and contract a horizontal block." },
	{ value: "triangle", label: "Triangle", description: "Rotate through filled triangle corners." },
	{ value: "circle-quarters", label: "Circle quarters", description: "Rotate a filled quarter around a circle." },
	{ value: "circle-halves", label: "Circle halves", description: "Rotate a filled half around a circle." },
	{ value: "bracket-spin", label: "Bracket spin", description: "Rotate an open bracket through four sides." },
	{ value: "dots", label: "Dots", description: "Move one Braille dot around its cell." },
	{ value: "quadrants", label: "Quadrants", description: "Move through the corners of one block cell." },
	{ value: "sparkle", label: "Sparkle", description: "Alternate a slow Unicode sparkle." },
	{ value: "braille-wave", label: "Braille wave", description: "Send a Braille dot wave across four cells." },
	{ value: "braille-dna", label: "Braille DNA", description: "Twist a Braille strand across four cells." },
	{ value: "braille-scan", label: "Braille scan", description: "Sweep a Braille bar across four cells." },
	{ value: "braille-rain", label: "Braille rain", description: "Drift a Braille rain pattern across four cells." },
	{ value: "braille-scanline", label: "Braille scanline", description: "Move a Braille scanline through three cells." },
	{ value: "braille-pulse", label: "Braille pulse", description: "Expand a Braille pulse across three cells." },
	{ value: "braille-sparkle", label: "Braille sparkle", description: "Scatter Braille sparks across four cells." },
	{ value: "braille-cascade", label: "Braille cascade", description: "Cascade a Braille wave across four cells." },
	{ value: "braille-columns", label: "Braille columns", description: "Fill three Braille columns in sequence." },
	{ value: "braille-orbit", label: "Braille orbit", description: "Orbit dots inside one Braille cell." },
	{ value: "braille-breathe", label: "Braille breathe", description: "Fill and empty one Braille cell." },
	{ value: "braille-wave-rows", label: "Braille wave rows", description: "Roll Braille rows across four cells." },
	{
		value: "braille-checkerboard",
		label: "Braille checkerboard",
		description: "Shift a three-cell Braille checkerboard.",
	},
	{ value: "braille-helix", label: "Braille helix", description: "Rotate a four-cell Braille double helix." },
	{ value: "scanline", label: "Scanline", description: "Fill and clear a three-cell Braille scanline." },
	{ value: "snake", label: "Snake", description: "Run a two-cell Braille snake around its track." },
	{ value: "fill-sweep", label: "Fill sweep", description: "Fill and clear two Braille cells vertically." },
	{ value: "diagonal-swipe", label: "Diagonal swipe", description: "Sweep a diagonal fill through two Braille cells." },
	{ value: "dna", label: "DNA", description: "Twist a compact three-cell Braille helix." },
	{ value: "radar", label: "Radar", description: "Sweep a Braille return across three cells." },
	{ value: "bounce", label: "Bounce", description: "Bounce a sparkle across three cells." },
	{ value: "orbit", label: "Orbit", description: "Orbit an arc around a compact sparkle." },
	{ value: "conveyor", label: "Conveyor", description: "Move a block along a three-cell track." },
	{ value: "heartbeat", label: "Heartbeat", description: "Pulse a compact ASCII heartbeat." },
	{
		value: "nerd-progress",
		label: "Progress spinner (Nerd Font)",
		description: "Rotate through the Fira Code progress-spinner glyphs.",
	},
	{ value: "nerd-morph", label: "Icon morph (Nerd Font)", description: "Morph through developer icons." },
	{
		value: "nerd-pipeline",
		label: "Pipeline (Nerd Font)",
		description: "Move build icons through a compact pipeline.",
	},
	{ value: "nerd-pi-orbit", label: "Pi orbit (Nerd Font)", description: "Orbit a spark around the Pi logo." },
] as const satisfies readonly { value: TuiActivityMarkerStyle; label: string; description: string }[]);

/** Text shimmer used independently from the activity marker. */
export type TuiShimmerStyle = "off" | "sweep" | "glow" | "rainbow" | "rainbow-glow" | "lightning";

/** Global pace applied to every configured activity animation. */
export type TuiAnimationSpeed = "slow" | "relaxed" | "normal" | "fast" | "very-fast";

/** Global repaint frequency used by every configured activity animation. */
export type TuiAnimationSmoothness = "economy" | "balanced" | "smooth" | "ultra";

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
	activityMarker: TuiActivityMarkerStyle;
	shimmer: TuiShimmerStyle;
	shimmerMarker: boolean;
	animationSpeed: TuiAnimationSpeed;
	animationSmoothness: TuiAnimationSmoothness;
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
	activityMarker: "spinner",
	shimmer: "off",
	shimmerMarker: false,
	animationSpeed: "normal",
	animationSmoothness: "balanced",
	powerline: false,
	powerlineButtons: false,
	softCursor: false,
	insertionCursor: "virtual",
	navigationCursor: "virtual",
	selectionCursor: "virtual",
});

const APPEARANCE_PROTOCOL = "pi-libtui/appearance/v4" as const;
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

/** Narrow an external value to one supported activity marker. */
export function isTuiActivityMarkerStyle(value: UntrustedAppearanceValue): value is TuiActivityMarkerStyle {
	return (
		value === "off" ||
		value === "spinner" ||
		value === "pulse" ||
		value === "static" ||
		value === "line" ||
		value === "arc" ||
		value === "pipe" ||
		value === "grow-vertical" ||
		value === "grow-horizontal" ||
		value === "triangle" ||
		value === "circle-quarters" ||
		value === "circle-halves" ||
		value === "bracket-spin" ||
		value === "dots" ||
		value === "quadrants" ||
		value === "sparkle" ||
		value === "braille-wave" ||
		value === "braille-dna" ||
		value === "braille-scan" ||
		value === "braille-rain" ||
		value === "braille-scanline" ||
		value === "braille-pulse" ||
		value === "braille-sparkle" ||
		value === "braille-cascade" ||
		value === "braille-columns" ||
		value === "braille-orbit" ||
		value === "braille-breathe" ||
		value === "braille-wave-rows" ||
		value === "braille-checkerboard" ||
		value === "braille-helix" ||
		value === "scanline" ||
		value === "snake" ||
		value === "fill-sweep" ||
		value === "diagonal-swipe" ||
		value === "dna" ||
		value === "radar" ||
		value === "bounce" ||
		value === "orbit" ||
		value === "conveyor" ||
		value === "heartbeat" ||
		value === "nerd-progress" ||
		value === "nerd-morph" ||
		value === "nerd-pipeline" ||
		value === "nerd-pi-orbit"
	);
}

/** Narrow an external value to one supported text shimmer. */
export function isTuiShimmerStyle(value: UntrustedAppearanceValue): value is TuiShimmerStyle {
	return (
		value === "off" ||
		value === "sweep" ||
		value === "glow" ||
		value === "rainbow" ||
		value === "rainbow-glow" ||
		value === "lightning"
	);
}

/** Narrow an external value to one supported animation speed. */
export function isTuiAnimationSpeed(value: UntrustedAppearanceValue): value is TuiAnimationSpeed {
	return value === "slow" || value === "relaxed" || value === "normal" || value === "fast" || value === "very-fast";
}

/** Narrow an external value to one supported animation smoothness. */
export function isTuiAnimationSmoothness(value: UntrustedAppearanceValue): value is TuiAnimationSmoothness {
	return value === "economy" || value === "balanced" || value === "smooth" || value === "ultra";
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
		activityMarker: isTuiActivityMarkerStyle(next.activityMarker) ? next.activityMarker : current.activityMarker,
		shimmer: isTuiShimmerStyle(next.shimmer) ? next.shimmer : current.shimmer,
		shimmerMarker: typeof next.shimmerMarker === "boolean" ? next.shimmerMarker : current.shimmerMarker,
		animationSpeed: isTuiAnimationSpeed(next.animationSpeed) ? next.animationSpeed : current.animationSpeed,
		animationSmoothness: isTuiAnimationSmoothness(next.animationSmoothness)
			? next.animationSmoothness
			: current.animationSmoothness,
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
		left.activityMarker === right.activityMarker &&
		left.shimmer === right.shimmer &&
		left.shimmerMarker === right.shimmerMarker &&
		left.animationSpeed === right.animationSpeed &&
		left.animationSmoothness === right.animationSmoothness &&
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
