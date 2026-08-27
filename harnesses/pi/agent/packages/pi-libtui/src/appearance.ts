import { bumpTuiRenderEpoch } from "./render-epoch.ts";

/** Glyph family used to resolve every semantic icon token. */
export type TuiIconPack = "nerd-fonts" | "unicode" | "emoji";

/** Compact glyph animation shown before an activity message. */
export type TuiActivityIndicatorStyle =
	| "off"
	| "spinner"
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

/** Stable indicator catalog for settings hosts and feature-owned overrides. */
export const TUI_ACTIVITY_INDICATOR_OPTIONS = Object.freeze([
	{ value: "off", label: "Off", description: "Do not show an activity indicator." },
	{ value: "spinner", label: "Spinner", description: "Rotate a compact Braille spinner." },
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
] as const satisfies readonly { value: TuiActivityIndicatorStyle; label: string; description: string }[]);

/** Message source used by the standard inline activity composition. */
export type TuiActivityMessageStyle = "phase" | "typewriter";

/** Status presentations that replace the standard inline composition. */
export type TuiStatusPresentationStyle =
	| "standard"
	| "neural-pulse"
	| "plasma-wave"
	| "pacman"
	| "matrix"
	| "pipeline"
	| "starfield"
	| "fire"
	| "icon-morph"
	| "brainstorm"
	| "dev-constellation"
	| "pi-pulse"
	| "orbit-dots"
	| "neon-bounce"
	| "block-wave"
	| "conveyor"
	| "accordion";

/** Stable status-presentation catalog for settings hosts and phase overrides. */
export const TUI_STATUS_PRESENTATION_OPTIONS = Object.freeze([
	{ value: "standard", label: "Standard", description: "Compose the configured indicator, message, and text effect." },
	{ value: "neural-pulse", label: "Neural pulse", description: "Send an energy pulse through connected nodes." },
	{ value: "plasma-wave", label: "Plasma wave", description: "Flow a colorful character wave across the row." },
	{ value: "pacman", label: "Pac-Man", description: "Chase a trail of dots across the row." },
	{ value: "matrix", label: "Matrix", description: "Stream a deterministic Matrix-style code rain." },
	{ value: "pipeline", label: "Pipeline (Nerd Font)", description: "Move energy through a developer tool pipeline." },
	{ value: "starfield", label: "Starfield", description: "Move layered stars across the row." },
	{ value: "fire", label: "Fire", description: "Animate a one-line demoscene fire field." },
	{ value: "icon-morph", label: "Icon morph (Nerd Font)", description: "Morph through developer icons and sparks." },
	{ value: "brainstorm", label: "Brainstorm (Nerd Font)", description: "Cycle weather states through a brainstorm." },
	{
		value: "dev-constellation",
		label: "Dev constellation (Nerd Font)",
		description: "Pulse across a constellation of developer icons.",
	},
	{ value: "pi-pulse", label: "Pi pulse (Nerd Font)", description: "Pulse the Pi logo through an orbiting gradient." },
	{ value: "orbit-dots", label: "Orbit dots", description: "Pulse five gradient dots beside the phase label." },
	{ value: "neon-bounce", label: "Neon bounce", description: "Bounce a bright block with a fading trail." },
	{ value: "block-wave", label: "Block wave", description: "Reflect a shaded block wave across its track." },
	{ value: "conveyor", label: "Conveyor", description: "Carry a shaded block along a fixed track." },
	{ value: "accordion", label: "Accordion", description: "Ease three shaded blocks back and forth." },
] as const satisfies readonly { value: TuiStatusPresentationStyle; label: string; description: string }[]);

/** Effect painted across the activity message and, optionally, its indicator. */
export type TuiTextEffectStyle =
	| "off"
	| "sweep"
	| "glow"
	| "rainbow"
	| "rainbow-glow"
	| "lightning"
	| "aurora"
	| "glitch"
	| "crush";

/** Part of the inline composition painted by the configured text effect. */
export type TuiTextEffectScope = "message" | "inline";

/** Pulse composed over an indicator and text effect. */
export type TuiPulseEffectStyle = "off" | "pulse" | "color";

export type TuiActivityPresentation =
	| {
			kind: "inline";
			indicatorStyle: TuiActivityIndicatorStyle;
			textEffectStyle: TuiTextEffectStyle;
			messageStyle: TuiActivityMessageStyle;
			textEffectScope: TuiTextEffectScope;
			pulseEffectStyle: TuiPulseEffectStyle;
	  }
	| { kind: "composition"; style: "brainstorm" | "orbit-dots" }
	| {
			kind: "scene";
			style: Exclude<TuiStatusPresentationStyle, "standard" | "brainstorm" | "orbit-dots">;
	  };

/** Global pace applied to every configured activity animation. */
export type TuiAnimationSpeed = "slow" | "relaxed" | "normal" | "fast" | "very-fast";

/** Global repaint frequency used by every configured activity animation. */
export type TuiAnimationSmoothness = "economy" | "balanced" | "smooth" | "ultra";

/** Request lifecycle phase shown by Pi's streaming status row. */
export type TuiRequestPhase = "thinking" | "working" | "tool";

/** One phase may inherit the general animation or replace it. */
export type TuiAnimationOverride<Value extends string> = "inherit" | Value;

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
	activityIndicator: TuiActivityIndicatorStyle;
	activityMessage: TuiActivityMessageStyle;
	textEffect: TuiTextEffectStyle;
	textEffectScope: TuiTextEffectScope;
	pulseEffect: TuiPulseEffectStyle;
	statusPresentation: TuiStatusPresentationStyle;
	animationSpeed: TuiAnimationSpeed;
	animationSmoothness: TuiAnimationSmoothness;
	thinkingIndicator: TuiAnimationOverride<TuiActivityIndicatorStyle>;
	thinkingMessage: TuiAnimationOverride<TuiActivityMessageStyle>;
	thinkingTextEffect: TuiAnimationOverride<TuiTextEffectStyle>;
	thinkingPulseEffect: TuiAnimationOverride<TuiPulseEffectStyle>;
	thinkingPresentation: TuiAnimationOverride<TuiStatusPresentationStyle>;
	workingIndicator: TuiAnimationOverride<TuiActivityIndicatorStyle>;
	workingMessage: TuiAnimationOverride<TuiActivityMessageStyle>;
	workingTextEffect: TuiAnimationOverride<TuiTextEffectStyle>;
	workingPulseEffect: TuiAnimationOverride<TuiPulseEffectStyle>;
	workingPresentation: TuiAnimationOverride<TuiStatusPresentationStyle>;
	toolIndicator: TuiAnimationOverride<TuiActivityIndicatorStyle>;
	toolMessage: TuiAnimationOverride<TuiActivityMessageStyle>;
	toolTextEffect: TuiAnimationOverride<TuiTextEffectStyle>;
	toolPulseEffect: TuiAnimationOverride<TuiPulseEffectStyle>;
	toolPresentation: TuiAnimationOverride<TuiStatusPresentationStyle>;
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
	activityIndicator: "spinner",
	activityMessage: "phase",
	textEffect: "off",
	textEffectScope: "message",
	pulseEffect: "off",
	statusPresentation: "standard",
	animationSpeed: "normal",
	animationSmoothness: "balanced",
	thinkingIndicator: "inherit",
	thinkingMessage: "inherit",
	thinkingTextEffect: "inherit",
	thinkingPulseEffect: "inherit",
	thinkingPresentation: "inherit",
	workingIndicator: "inherit",
	workingMessage: "inherit",
	workingTextEffect: "inherit",
	workingPulseEffect: "inherit",
	workingPresentation: "inherit",
	toolIndicator: "inherit",
	toolMessage: "inherit",
	toolTextEffect: "inherit",
	toolPulseEffect: "inherit",
	toolPresentation: "inherit",
	powerline: false,
	powerlineButtons: false,
	softCursor: false,
	insertionCursor: "virtual",
	navigationCursor: "virtual",
	selectionCursor: "virtual",
});

const APPEARANCE_PROTOCOL = "pi-libtui/appearance/v7" as const;
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
export function isTuiActivityIndicatorStyle(value: UntrustedAppearanceValue): value is TuiActivityIndicatorStyle {
	return (
		value === "off" ||
		value === "spinner" ||
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

/** Narrow an external value to one supported status presentation. */
export function isTuiStatusPresentationStyle(value: UntrustedAppearanceValue): value is TuiStatusPresentationStyle {
	return (
		value === "standard" ||
		value === "neural-pulse" ||
		value === "plasma-wave" ||
		value === "pacman" ||
		value === "matrix" ||
		value === "pipeline" ||
		value === "starfield" ||
		value === "fire" ||
		value === "icon-morph" ||
		value === "brainstorm" ||
		value === "dev-constellation" ||
		value === "pi-pulse" ||
		value === "orbit-dots" ||
		value === "neon-bounce" ||
		value === "block-wave" ||
		value === "conveyor" ||
		value === "accordion"
	);
}

/** Narrow an external value to one supported activity message source. */
export function isTuiActivityMessageStyle(value: UntrustedAppearanceValue): value is TuiActivityMessageStyle {
	return value === "phase" || value === "typewriter";
}

/** Narrow an external value to one supported text effect. */
export function isTuiTextEffectStyle(value: UntrustedAppearanceValue): value is TuiTextEffectStyle {
	return (
		value === "off" ||
		value === "sweep" ||
		value === "glow" ||
		value === "rainbow" ||
		value === "rainbow-glow" ||
		value === "lightning" ||
		value === "aurora" ||
		value === "glitch" ||
		value === "crush"
	);
}

/** Narrow an external value to one supported text-effect scope. */
export function isTuiTextEffectScope(value: UntrustedAppearanceValue): value is TuiTextEffectScope {
	return value === "message" || value === "inline";
}

/** Narrow an external value to one supported pulse effect. */
export function isTuiPulseEffectStyle(value: UntrustedAppearanceValue): value is TuiPulseEffectStyle {
	return value === "off" || value === "pulse" || value === "color";
}

function isMarkerOverride(value: UntrustedAppearanceValue): value is TuiAnimationOverride<TuiActivityIndicatorStyle> {
	return value === "inherit" || isTuiActivityIndicatorStyle(value);
}

function isTextEffectOverride(value: UntrustedAppearanceValue): value is TuiAnimationOverride<TuiTextEffectStyle> {
	return value === "inherit" || isTuiTextEffectStyle(value);
}

function isPulseEffectOverride(value: UntrustedAppearanceValue): value is TuiAnimationOverride<TuiPulseEffectStyle> {
	return value === "inherit" || isTuiPulseEffectStyle(value);
}

function isMessageOverride(value: UntrustedAppearanceValue): value is TuiAnimationOverride<TuiActivityMessageStyle> {
	return value === "inherit" || isTuiActivityMessageStyle(value);
}

function isPresentationOverride(
	value: UntrustedAppearanceValue,
): value is TuiAnimationOverride<TuiStatusPresentationStyle> {
	return value === "inherit" || isTuiStatusPresentationStyle(value);
}

/** Narrow an external value to one supported animation speed. */
export function isTuiAnimationSpeed(value: UntrustedAppearanceValue): value is TuiAnimationSpeed {
	return value === "slow" || value === "relaxed" || value === "normal" || value === "fast" || value === "very-fast";
}

/** Narrow an external value to one supported animation smoothness. */
export function isTuiAnimationSmoothness(value: UntrustedAppearanceValue): value is TuiAnimationSmoothness {
	return value === "economy" || value === "balanced" || value === "smooth" || value === "ultra";
}

/** Resolve one request phase against the general activity animation. */
export function requestPhaseAnimation(
	phase: TuiRequestPhase,
	appearance: Readonly<TuiAppearanceSettings> = getTuiAppearance(),
): TuiActivityPresentation {
	const indicator = appearance[`${phase}Indicator`];
	const message = appearance[`${phase}Message`];
	const effect = appearance[`${phase}TextEffect`];
	const pulse = appearance[`${phase}PulseEffect`];
	const presentation = appearance[`${phase}Presentation`];
	return resolveActivityPresentation(
		indicator === "inherit" ? appearance.activityIndicator : indicator,
		message === "inherit" ? appearance.activityMessage : message,
		effect === "inherit" ? appearance.textEffect : effect,
		appearance.textEffectScope,
		pulse === "inherit" ? appearance.pulseEffect : pulse,
		presentation === "inherit" ? appearance.statusPresentation : presentation,
	);
}

/** Build the valid activity topology for one inline composition or exclusive presentation. */
export function resolveActivityPresentation(
	indicatorStyle: TuiActivityIndicatorStyle,
	messageStyle: TuiActivityMessageStyle,
	textEffectStyle: TuiTextEffectStyle,
	textEffectScope: TuiTextEffectScope,
	pulseEffectStyle: TuiPulseEffectStyle,
	presentationStyle: TuiStatusPresentationStyle,
): TuiActivityPresentation {
	if (presentationStyle === "standard")
		return { kind: "inline", indicatorStyle, messageStyle, textEffectStyle, textEffectScope, pulseEffectStyle };
	if (presentationStyle === "brainstorm" || presentationStyle === "orbit-dots")
		return { kind: "composition", style: presentationStyle };
	return { kind: "scene", style: presentationStyle };
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
		activityIndicator: isTuiActivityIndicatorStyle(next.activityIndicator)
			? next.activityIndicator
			: current.activityIndicator,
		activityMessage: isTuiActivityMessageStyle(next.activityMessage) ? next.activityMessage : current.activityMessage,
		textEffect: isTuiTextEffectStyle(next.textEffect) ? next.textEffect : current.textEffect,
		textEffectScope: isTuiTextEffectScope(next.textEffectScope) ? next.textEffectScope : current.textEffectScope,
		pulseEffect: isTuiPulseEffectStyle(next.pulseEffect) ? next.pulseEffect : current.pulseEffect,
		statusPresentation: isTuiStatusPresentationStyle(next.statusPresentation)
			? next.statusPresentation
			: current.statusPresentation,
		animationSpeed: isTuiAnimationSpeed(next.animationSpeed) ? next.animationSpeed : current.animationSpeed,
		animationSmoothness: isTuiAnimationSmoothness(next.animationSmoothness)
			? next.animationSmoothness
			: current.animationSmoothness,
		thinkingIndicator: isMarkerOverride(next.thinkingIndicator) ? next.thinkingIndicator : current.thinkingIndicator,
		thinkingMessage: isMessageOverride(next.thinkingMessage) ? next.thinkingMessage : current.thinkingMessage,
		thinkingTextEffect: isTextEffectOverride(next.thinkingTextEffect)
			? next.thinkingTextEffect
			: current.thinkingTextEffect,
		thinkingPulseEffect: isPulseEffectOverride(next.thinkingPulseEffect)
			? next.thinkingPulseEffect
			: current.thinkingPulseEffect,
		thinkingPresentation: isPresentationOverride(next.thinkingPresentation)
			? next.thinkingPresentation
			: current.thinkingPresentation,
		workingIndicator: isMarkerOverride(next.workingIndicator) ? next.workingIndicator : current.workingIndicator,
		workingMessage: isMessageOverride(next.workingMessage) ? next.workingMessage : current.workingMessage,
		workingTextEffect: isTextEffectOverride(next.workingTextEffect)
			? next.workingTextEffect
			: current.workingTextEffect,
		workingPulseEffect: isPulseEffectOverride(next.workingPulseEffect)
			? next.workingPulseEffect
			: current.workingPulseEffect,
		workingPresentation: isPresentationOverride(next.workingPresentation)
			? next.workingPresentation
			: current.workingPresentation,
		toolIndicator: isMarkerOverride(next.toolIndicator) ? next.toolIndicator : current.toolIndicator,
		toolMessage: isMessageOverride(next.toolMessage) ? next.toolMessage : current.toolMessage,
		toolTextEffect: isTextEffectOverride(next.toolTextEffect) ? next.toolTextEffect : current.toolTextEffect,
		toolPulseEffect: isPulseEffectOverride(next.toolPulseEffect) ? next.toolPulseEffect : current.toolPulseEffect,
		toolPresentation: isPresentationOverride(next.toolPresentation) ? next.toolPresentation : current.toolPresentation,
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
		left.activityIndicator === right.activityIndicator &&
		left.activityMessage === right.activityMessage &&
		left.textEffect === right.textEffect &&
		left.textEffectScope === right.textEffectScope &&
		left.pulseEffect === right.pulseEffect &&
		left.statusPresentation === right.statusPresentation &&
		left.animationSpeed === right.animationSpeed &&
		left.animationSmoothness === right.animationSmoothness &&
		left.thinkingIndicator === right.thinkingIndicator &&
		left.thinkingMessage === right.thinkingMessage &&
		left.thinkingTextEffect === right.thinkingTextEffect &&
		left.thinkingPulseEffect === right.thinkingPulseEffect &&
		left.thinkingPresentation === right.thinkingPresentation &&
		left.workingIndicator === right.workingIndicator &&
		left.workingMessage === right.workingMessage &&
		left.workingTextEffect === right.workingTextEffect &&
		left.workingPulseEffect === right.workingPulseEffect &&
		left.workingPresentation === right.workingPresentation &&
		left.toolIndicator === right.toolIndicator &&
		left.toolMessage === right.toolMessage &&
		left.toolTextEffect === right.toolTextEffect &&
		left.toolPulseEffect === right.toolPulseEffect &&
		left.toolPresentation === right.toolPresentation &&
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
