import { visibleWidth } from "@earendil-works/pi-tui";
import type { TuiForegroundColor, TuiForegroundToken, TuiHue, TuiTheme } from "./color/theme.ts";
import {
	getTuiAppearance,
	subscribeTuiAppearance,
	type TuiActivityMarkerStyle,
	type TuiAnimationSmoothness,
	type TuiAnimationSpeed,
	type TuiShimmerStyle,
} from "./appearance.ts";
import { sanitizeTuiText } from "./content/terminal-text.ts";

/** A host surface that can schedule a TUI render. */
export interface MotionRenderTarget {
	requestRender(): void;
}

/** A timer handle with Node/Bun's optional process-liveness control. */
export interface MotionTimerHandle {
	unref?(): void;
}

/** Idempotent ownership handle returned by the motion scheduler. */
export interface MotionMount {
	dispose(): void;
}

/** Injectable timer and clock boundary used by the shared scheduler. */
export interface MotionClock {
	now(): number;
	start(callback: () => void, cadenceMs: number): MotionTimerHandle;
	stop(handle: MotionTimerHandle): void;
}

/** Options for one cadence registration. */
export interface MotionMountOptions {
	/** Frame cadence in milliseconds. Values below 16ms are clamped. */
	cadenceMs: number;
	/** Called on this registration's cadence before the host render request. */
	onFrame?(nowMs: number): void;
	/** Avoid allocating a timer while preserving a disposable mount. */
	reducedMotion?: boolean;
	/** Stop invalidating an abandoned surface after this many milliseconds. */
	maxDurationMs?: number;
}

interface MotionRegistration {
	id: number;
	onFrame?: (nowMs: number) => void;
	expiresAtMs?: number;
}

interface TargetRegistration {
	registrations: Map<number, MotionRegistration>;
}

interface CadenceBucket {
	timer: MotionTimerHandle;
	targets: Map<MotionRenderTarget, TargetRegistration>;
}

const systemClock: MotionClock = {
	now: () => performance.now(),
	start(callback, cadenceMs) {
		return setInterval(callback, cadenceMs);
	},
	stop(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};

/**
 * Shares one unreferenced timer per cadence across every mounted animation.
 *
 * A target mounted at several cadences is invalidated only by its fastest
 * cadence. Slower callbacks still advance their own state, avoiding duplicate
 * whole-tree renders while retaining independent animation clocks.
 */
export class MotionScheduler {
	private readonly buckets = new Map<number, CadenceBucket>();
	private readonly targetsByRequest = new WeakMap<MotionRenderTarget["requestRender"], MotionRenderTarget>();
	private nextRegistrationId = 1;
	private mountCount = 0;

	constructor(private readonly clock: MotionClock = systemClock) {}

	/** Register a target on a shared cadence bucket. */
	mount(target: MotionRenderTarget, options: MotionMountOptions): MotionMount {
		if (options.reducedMotion) return disposable(() => {});
		target = this.canonicalTarget(target);
		const cadenceMs = Number.isFinite(options.cadenceMs) ? Math.max(16, Math.floor(options.cadenceMs)) : 120;
		let bucket = this.buckets.get(cadenceMs);
		if (!bucket) {
			const targets = new Map<MotionRenderTarget, TargetRegistration>();
			const timer = this.clock.start(() => this.tick(cadenceMs, targets), cadenceMs);
			timer.unref?.();
			bucket = { timer, targets };
			this.buckets.set(cadenceMs, bucket);
		}
		const targetRegistration = bucket.targets.get(target) ?? { registrations: new Map() };
		const id = this.nextRegistrationId++;
		const maxDurationMs = Number.isFinite(options.maxDurationMs) ? options.maxDurationMs : undefined;
		targetRegistration.registrations.set(id, {
			id,
			onFrame: options.onFrame,
			expiresAtMs: maxDurationMs === undefined ? undefined : this.clock.now() + Math.max(0, maxDurationMs),
		});
		bucket.targets.set(target, targetRegistration);
		this.mountCount++;
		return disposable(() => {
			const currentBucket = this.buckets.get(cadenceMs);
			const currentTarget = currentBucket?.targets.get(target);
			if (!currentBucket || !currentTarget?.registrations.delete(id)) return;
			this.mountCount--;
			if (currentTarget.registrations.size === 0) currentBucket.targets.delete(target);
			if (currentBucket.targets.size > 0) return;
			this.clock.stop(currentBucket.timer);
			this.buckets.delete(cadenceMs);
		});
	}

	private canonicalTarget(target: MotionRenderTarget): MotionRenderTarget {
		// Keep class instances intact: copying a prototype method into a plain
		// object drops the renderer's `this` receiver. Plain callback wrappers are
		// safe to canonicalize because their own requestRender property is already
		// bound or closure-based.
		if (!Object.hasOwn(target, "requestRender")) return target;
		const requestRender = target.requestRender;
		let canonical = this.targetsByRequest.get(requestRender);
		if (!canonical) {
			canonical = { requestRender };
			this.targetsByRequest.set(requestRender, canonical);
		}
		return canonical;
	}

	private tick(cadenceMs: number, targets: Map<MotionRenderTarget, TargetRegistration>): void {
		const nowMs = this.clock.now();
		for (const [target, registration] of targets) {
			for (const current of registration.registrations.values()) {
				if (current.expiresAtMs === undefined || nowMs < current.expiresAtMs) continue;
				registration.registrations.delete(current.id);
				this.mountCount--;
			}
			if (registration.registrations.size === 0) {
				targets.delete(target);
				continue;
			}
			for (const current of registration.registrations.values()) {
				try {
					current.onFrame?.(nowMs);
				} catch {
					registration.registrations.delete(current.id);
					this.mountCount--;
				}
			}
			if (registration.registrations.size === 0) {
				targets.delete(target);
				continue;
			}
			if (this.fastestCadence(target) === cadenceMs) {
				try {
					target.requestRender();
				} catch {
					this.mountCount -= registration.registrations.size;
					registration.registrations.clear();
					targets.delete(target);
				}
			}
		}
		if (targets.size > 0) return;
		const bucket = this.buckets.get(cadenceMs);
		if (!bucket || bucket.targets !== targets) return;
		this.clock.stop(bucket.timer);
		this.buckets.delete(cadenceMs);
	}

	private fastestCadence(target: MotionRenderTarget): number | undefined {
		let fastest: number | undefined;
		for (const [cadence, bucket] of this.buckets) {
			if (!bucket.targets.has(target)) continue;
			fastest = fastest === undefined ? cadence : Math.min(fastest, cadence);
		}
		return fastest;
	}

	/** Number of live cadence timers. */
	get activeTimerCount(): number {
		return this.buckets.size;
	}

	/** Number of live mounts, including shared target/cadence registrations. */
	get activeMountCount(): number {
		return this.mountCount;
	}
}

function disposable(dispose: () => void): MotionMount {
	let active = true;
	return {
		dispose() {
			if (!active) return;
			active = false;
			dispose();
		},
	};
}

const SHARED_MOTION_SCHEDULER = Symbol.for("pi-libtui.motionScheduler.v1");
type MotionGlobal = typeof globalThis & { [SHARED_MOTION_SCHEDULER]?: MotionScheduler };

function resolveSharedMotionScheduler(): MotionScheduler {
	const motionGlobal = globalThis as MotionGlobal;
	let scheduler = motionGlobal[SHARED_MOTION_SCHEDULER];
	if (!scheduler) {
		scheduler = new MotionScheduler();
		motionGlobal[SHARED_MOTION_SCHEDULER] = scheduler;
	}
	return scheduler;
}

class SharedMotionScheduler extends MotionScheduler {
	override mount(target: MotionRenderTarget, options: MotionMountOptions): MotionMount {
		return resolveSharedMotionScheduler().mount(target, options);
	}

	override get activeTimerCount(): number {
		return resolveSharedMotionScheduler().activeTimerCount;
	}

	override get activeMountCount(): number {
		return resolveSharedMotionScheduler().activeMountCount;
	}
}

/** Process-wide cadence scheduler, initialized only when animation is used. */
export const sharedMotionScheduler: MotionScheduler = new SharedMotionScheduler();

/** Per-surface choices. Omitted values inherit the process-wide appearance. */
export interface ActivityAnimationOverrides {
	markerStyle?: TuiActivityMarkerStyle;
	shimmerStyle?: TuiShimmerStyle;
	shimmerMarker?: boolean;
	animationSpeed?: TuiAnimationSpeed;
	animationSmoothness?: TuiAnimationSmoothness;
}

/** Repaint cadence selected independently from animation pace. */
export function configuredAnimationCadenceMs(
	marker = getTuiAppearance().activityMarker,
	shimmer = getTuiAppearance().shimmer,
	smoothness: TuiAnimationSmoothness = getTuiAppearance().animationSmoothness,
	speed: TuiAnimationSpeed = getTuiAppearance().animationSpeed,
): number | undefined {
	const intrinsicCadences = [markerCadenceMs(marker), shimmerCadenceMs(shimmer)].filter(
		(cadence): cadence is number => cadence !== undefined,
	);
	if (intrinsicCadences.length === 0) return undefined;
	const designedCadenceMs = Math.min(...intrinsicCadences) / animationSpeedMultiplier(speed);
	return Math.max(animationSmoothnessCadenceMs(smoothness), Math.floor(designedCadenceMs));
}

/** Timeline multiplier for one configured animation speed. */
export function animationSpeedMultiplier(speed: TuiAnimationSpeed = getTuiAppearance().animationSpeed): number {
	return speed === "slow" ? 0.6 : speed === "relaxed" ? 0.8 : speed === "fast" ? 1.35 : speed === "very-fast" ? 1.7 : 1;
}

/** Shared terminal repaint cadence for one configured smoothness. */
export function animationSmoothnessCadenceMs(
	smoothness: TuiAnimationSmoothness = getTuiAppearance().animationSmoothness,
): number {
	return smoothness === "economy" ? 120 : smoothness === "smooth" ? 40 : smoothness === "ultra" ? 25 : 60;
}

/** Whether the configured activity presentation animates its text. */
export function activityAnimatesText(style = getTuiAppearance().shimmer): boolean {
	return style !== "off";
}

function markerCadenceMs(style: TuiActivityMarkerStyle): number | undefined {
	return style === "pulse" ? 120 : markerAnimation(style)?.cadenceMs;
}

function shimmerCadenceMs(style: TuiShimmerStyle): number | undefined {
	return style === "sweep"
		? 90
		: style === "glow"
			? 70
			: style === "rainbow" || style === "rainbow-glow"
				? 80
				: style === "lightning"
					? 60
					: undefined;
}

/**
 * Mount the process-wide configured animation and follow live appearance changes.
 *
 * The returned mount retains the appearance subscription even for the static
 * style so switching animations can start the timer without rebuilding the UI.
 */
export function mountConfiguredAnimation(
	target: MotionRenderTarget,
	options: ActivityAnimationOverrides &
		Pick<MotionMountOptions, "onFrame" | "maxDurationMs" | "reducedMotion"> & {
			cadenceMs?: number;
			scheduler?: MotionScheduler;
		} = {},
): MotionMount {
	let timer: MotionMount | undefined;
	let disposed = false;
	const expiresAtMs =
		options.maxDurationMs === undefined ? undefined : performance.now() + Math.max(0, options.maxDurationMs);
	const sync = (): void => {
		timer?.dispose();
		timer = undefined;
		const cadenceMs = options.reducedMotion
			? undefined
			: (options.cadenceMs ??
				configuredAnimationCadenceMs(
					options.markerStyle,
					options.shimmerStyle,
					options.animationSmoothness,
					options.animationSpeed,
				));
		const maxDurationMs = expiresAtMs === undefined ? undefined : expiresAtMs - performance.now();
		if (cadenceMs === undefined || disposed || (maxDurationMs !== undefined && maxDurationMs <= 0)) return;
		timer = (options.scheduler ?? sharedMotionScheduler).mount(target, {
			cadenceMs,
			maxDurationMs,
			onFrame: options.onFrame,
		});
	};
	const unsubscribe = subscribeTuiAppearance(() => {
		sync();
		target.requestRender();
	});
	sync();
	return disposable(() => {
		disposed = true;
		unsubscribe();
		timer?.dispose();
		timer = undefined;
	});
}

/** Portable braille spinner frames. */
export const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const);

/** Curated portable single-cell animation frames. */
export const LINE_FRAMES = Object.freeze(["-", "\\", "|", "/"] as const);
export const ARC_FRAMES = Object.freeze(["◜", "◠", "◝", "◞", "◡", "◟"] as const);
export const NERD_PROGRESS_FRAMES = Object.freeze(["", "", "", "", "", ""] as const);
export const PIPE_FRAMES = Object.freeze(["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"] as const);
export const GROW_VERTICAL_FRAMES = Object.freeze(["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"] as const);
export const GROW_HORIZONTAL_FRAMES = Object.freeze([
	"▏",
	"▎",
	"▍",
	"▌",
	"▋",
	"▊",
	"▉",
	"▊",
	"▋",
	"▌",
	"▍",
	"▎",
] as const);
export const TRIANGLE_FRAMES = Object.freeze(["◢", "◣", "◤", "◥"] as const);
export const CIRCLE_QUARTER_FRAMES = Object.freeze(["◴", "◷", "◶", "◵"] as const);
export const CIRCLE_HALF_FRAMES = Object.freeze(["◐", "◓", "◑", "◒"] as const);
export const BRACKET_SPIN_FRAMES = Object.freeze(["⊏", "⊓", "⊐", "⊔"] as const);
export const DOT_FRAMES = Object.freeze(["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"] as const);
export const QUADRANT_FRAMES = Object.freeze(["▖", "▘", "▝", "▗"] as const);
export const SPARKLE_FRAMES = Object.freeze(["✦", "✧"] as const);
export const BRAILLE_WAVE_FRAMES = Object.freeze([
	"⠁⠂⠄⡀",
	"⠂⠄⡀⢀",
	"⠄⡀⢀⠠",
	"⡀⢀⠠⠐",
	"⢀⠠⠐⠈",
	"⠠⠐⠈⠁",
	"⠐⠈⠁⠂",
	"⠈⠁⠂⠄",
] as const);
export const BRAILLE_DNA_FRAMES = Object.freeze([
	"⠋⠉⠙⠚",
	"⠉⠙⠚⠒",
	"⠙⠚⠒⠂",
	"⠚⠒⠂⠂",
	"⠒⠂⠂⠒",
	"⠂⠂⠒⠲",
	"⠂⠒⠲⠴",
	"⠒⠲⠴⠤",
	"⠲⠴⠤⠄",
	"⠴⠤⠄⠋",
	"⠤⠄⠋⠉",
	"⠄⠋⠉⠙",
] as const);
export const BRAILLE_SCAN_FRAMES = Object.freeze([
	"⠀⠀⠀⠀",
	"⡇⠀⠀⠀",
	"⣿⠀⠀⠀",
	"⢸⡇⠀⠀",
	"⠀⣿⠀⠀",
	"⠀⢸⡇⠀",
	"⠀⠀⣿⠀",
	"⠀⠀⢸⡇",
	"⠀⠀⠀⣿",
	"⠀⠀⠀⢸",
] as const);
export const BRAILLE_RAIN_FRAMES = Object.freeze([
	"⢁⠂⠔⠈",
	"⠂⠌⡠⠐",
	"⠄⡐⢀⠡",
	"⡈⠠⠀⢂",
	"⠐⢀⠁⠄",
	"⠠⠁⠊⡀",
	"⢁⠂⠔⠈",
	"⠂⠌⡠⠐",
	"⠄⡐⢀⠡",
	"⡈⠠⠀⢂",
	"⠐⢀⠁⠄",
	"⠠⠁⠊⡀",
] as const);
export const BRAILLE_SCANLINE_FRAMES = Object.freeze(["⠉⠉⠉", "⠓⠓⠓", "⠦⠦⠦", "⣄⣄⣄", "⠦⠦⠦", "⠓⠓⠓"] as const);
export const BRAILLE_PULSE_FRAMES = Object.freeze(["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"] as const);
export const BRAILLE_SPARKLE_FRAMES = Object.freeze(["⡡⠊⢔⠡", "⠊⡰⡡⡘", "⢔⢅⠈⢢", "⡁⢂⠆⡍", "⢔⠨⢑⢐", "⠨⡑⡠⠊"] as const);
export const BRAILLE_CASCADE_FRAMES = Object.freeze([
	"⠀⠀⠀⠀",
	"⠀⠀⠀⠀",
	"⠁⠀⠀⠀",
	"⠋⠀⠀⠀",
	"⠞⠁⠀⠀",
	"⡴⠋⠀⠀",
	"⣠⠞⠁⠀",
	"⢀⡴⠋⠀",
	"⠀⣠⠞⠁",
	"⠀⢀⡴⠋",
	"⠀⠀⣠⠞",
	"⠀⠀⢀⡴",
	"⠀⠀⠀⣠",
	"⠀⠀⠀⢀",
] as const);
export const BRAILLE_COLUMNS_FRAMES = Object.freeze([
	"⡀⠀⠀",
	"⡄⠀⠀",
	"⡆⠀⠀",
	"⡇⠀⠀",
	"⣇⠀⠀",
	"⣧⠀⠀",
	"⣷⠀⠀",
	"⣿⠀⠀",
	"⣿⡀⠀",
	"⣿⡄⠀",
	"⣿⡆⠀",
	"⣿⡇⠀",
	"⣿⣇⠀",
	"⣿⣧⠀",
	"⣿⣷⠀",
	"⣿⣿⠀",
	"⣿⣿⡀",
	"⣿⣿⡄",
	"⣿⣿⡆",
	"⣿⣿⡇",
	"⣿⣿⣇",
	"⣿⣿⣧",
	"⣿⣿⣷",
	"⣿⣿⣿",
	"⣿⣿⣿",
	"⠀⠀⠀",
] as const);
export const BRAILLE_ORBIT_FRAMES = Object.freeze(["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"] as const);
export const BRAILLE_BREATHE_FRAMES = Object.freeze([
	"⠀",
	"⠂",
	"⠌",
	"⡑",
	"⢕",
	"⢝",
	"⣫",
	"⣟",
	"⣿",
	"⣟",
	"⣫",
	"⢝",
	"⢕",
	"⡑",
	"⠌",
	"⠂",
	"⠀",
] as const);
export const BRAILLE_WAVE_ROWS_FRAMES = Object.freeze([
	"⠖⠉⠉⠑",
	"⡠⠖⠉⠉",
	"⣠⡠⠖⠉",
	"⣄⣠⡠⠖",
	"⠢⣄⣠⡠",
	"⠙⠢⣄⣠",
	"⠉⠙⠢⣄",
	"⠊⠉⠙⠢",
	"⠜⠊⠉⠙",
	"⡤⠜⠊⠉",
	"⣀⡤⠜⠊",
	"⢤⣀⡤⠜",
	"⠣⢤⣀⡤",
	"⠑⠣⢤⣀",
	"⠉⠑⠣⢤",
	"⠋⠉⠑⠣",
] as const);
export const BRAILLE_CHECKERBOARD_FRAMES = Object.freeze(["⢕⢕⢕", "⡪⡪⡪", "⢊⠔⡡", "⡡⢊⠔"] as const);
export const BRAILLE_HELIX_FRAMES = Object.freeze([
	"⢌⣉⢎⣉",
	"⣉⡱⣉⡱",
	"⣉⢎⣉⢎",
	"⡱⣉⡱⣉",
	"⢎⣉⢎⣉",
	"⣉⡱⣉⡱",
	"⣉⢎⣉⢎",
	"⡱⣉⡱⣉",
	"⢎⣉⢎⣉",
	"⣉⡱⣉⡱",
	"⣉⢎⣉⢎",
	"⡱⣉⡱⣉",
	"⢎⣉⢎⣉",
	"⣉⡱⣉⡱",
	"⣉⢎⣉⢎",
	"⡱⣉⡱⣉",
] as const);
export const SCANLINE_FRAMES = Object.freeze(["⠉⠉⠉", "⠛⠛⠛", "⠿⠿⠿", "⣿⣿⣿", "⣶⣶⣶", "⣤⣤⣤", "⣀⣀⣀", "⠀⠀⠀"] as const);
export const SNAKE_FRAMES = Object.freeze([
	"⣁⡀",
	"⣉⠀",
	"⡉⠁",
	"⠉⠉",
	"⠈⠙",
	"⠀⠛",
	"⠐⠚",
	"⠒⠒",
	"⠖⠂",
	"⠶⠀",
	"⠦⠄",
	"⠤⠤",
	"⠠⢤",
	"⠀⣤",
	"⢀⣠",
	"⣀⣀",
] as const);
export const FILL_SWEEP_FRAMES = Object.freeze([
	"⣀⣀",
	"⣤⣤",
	"⣶⣶",
	"⣿⣿",
	"⣿⣿",
	"⣿⣿",
	"⣶⣶",
	"⣤⣤",
	"⣀⣀",
	"⠀⠀",
	"⠀⠀",
] as const);
export const DIAGONAL_SWIPE_FRAMES = Object.freeze([
	"⠁⠀",
	"⠋⠀",
	"⠟⠁",
	"⡿⠋",
	"⣿⠟",
	"⣿⡿",
	"⣿⣿",
	"⣿⣿",
	"⣾⣿",
	"⣴⣿",
	"⣠⣾",
	"⢀⣴",
	"⠀⣠",
	"⠀⢀",
	"⠀⠀",
	"⠀⠀",
] as const);
export const DNA_FRAMES = Object.freeze(["⠋⠉⠙", "⠙⠒⠚", "⠚⠤⠴", "⠴⠤⠦", "⠦⠒⠋"] as const);
export const RADAR_FRAMES = Object.freeze(["⠁  ", " ⠂ ", "  ⠄", " ⠂ "] as const);
export const BOUNCE_FRAMES = Object.freeze(["✦  ", " ✦ ", "  ✦", " ✦ "] as const);
export const ORBIT_FRAMES = Object.freeze(["◜✦ ", "◠✦ ", "◝✦ ", " ✦◞", " ✦◡", " ✦◟"] as const);
export const CONVEYOR_FRAMES = Object.freeze(["▰▱▱", "▱▰▱", "▱▱▰", "▱▰▱"] as const);
export const HEARTBEAT_FRAMES = Object.freeze([" . ", " . ", " - ", "=|=", " - ", " . "] as const);
export const NERD_MORPH_FRAMES = Object.freeze([
	"\uf0eb",
	"\uf013",
	"\uf0e7",
	"\uf135",
	"\uf005",
	"\uf06d",
	"\uf0ac",
	"\uf004",
] as const);
export const NERD_PIPELINE_FRAMES = Object.freeze([
	"\uf0e7--",
	"-\uf013-",
	"--\uf121",
	"-\uf0ad-",
	"\uf00c--",
] as const);
export const NERD_PI_ORBIT_FRAMES = Object.freeze(["*\ue22c.", " \ue22c*", ".\ue22c*", "*\ue22c "] as const);
const DOUBLE_LINE_FRAMES = Object.freeze(["| ", " /", " -", "\\ "] as const);
const TRIPLE_LINE_FRAMES = Object.freeze(["|  ", " / ", "  -", " \\ "] as const);
const QUADRUPLE_LINE_FRAMES = Object.freeze(["|   ", " /  ", "  - ", "   \\"] as const);

type MarkerWidth = 1 | 2 | 3 | 4;

interface MarkerAnimation {
	readonly frames: readonly string[];
	readonly cadenceMs: number;
	readonly width: MarkerWidth;
	readonly nerdFonts?: true;
	readonly nerdFrames?: readonly string[];
}

type AnimatedMarkerStyle = Exclude<TuiActivityMarkerStyle, "off" | "pulse" | "static">;

const MARKER_ANIMATIONS = Object.freeze({
	spinner: { frames: SPINNER_FRAMES, cadenceMs: 80, width: 1 },
	line: { frames: LINE_FRAMES, cadenceMs: 100, width: 1 },
	arc: { frames: ARC_FRAMES, cadenceMs: 90, width: 1 },
	pipe: { frames: PIPE_FRAMES, cadenceMs: 100, width: 1 },
	"grow-vertical": { frames: GROW_VERTICAL_FRAMES, cadenceMs: 100, width: 1 },
	"grow-horizontal": { frames: GROW_HORIZONTAL_FRAMES, cadenceMs: 100, width: 1 },
	triangle: { frames: TRIANGLE_FRAMES, cadenceMs: 120, width: 1 },
	"circle-quarters": { frames: CIRCLE_QUARTER_FRAMES, cadenceMs: 120, width: 1 },
	"circle-halves": { frames: CIRCLE_HALF_FRAMES, cadenceMs: 120, width: 1 },
	"bracket-spin": { frames: BRACKET_SPIN_FRAMES, cadenceMs: 120, width: 1 },
	dots: { frames: DOT_FRAMES, cadenceMs: 80, width: 1 },
	quadrants: { frames: QUADRANT_FRAMES, cadenceMs: 100, width: 1 },
	sparkle: { frames: SPARKLE_FRAMES, cadenceMs: 240, width: 1 },
	"braille-wave": { frames: BRAILLE_WAVE_FRAMES, cadenceMs: 100, width: 4 },
	"braille-dna": { frames: BRAILLE_DNA_FRAMES, cadenceMs: 80, width: 4 },
	"braille-scan": { frames: BRAILLE_SCAN_FRAMES, cadenceMs: 70, width: 4 },
	"braille-rain": { frames: BRAILLE_RAIN_FRAMES, cadenceMs: 100, width: 4 },
	"braille-scanline": { frames: BRAILLE_SCANLINE_FRAMES, cadenceMs: 120, width: 3 },
	"braille-pulse": { frames: BRAILLE_PULSE_FRAMES, cadenceMs: 180, width: 3 },
	"braille-sparkle": { frames: BRAILLE_SPARKLE_FRAMES, cadenceMs: 150, width: 4 },
	"braille-cascade": { frames: BRAILLE_CASCADE_FRAMES, cadenceMs: 60, width: 4 },
	"braille-columns": { frames: BRAILLE_COLUMNS_FRAMES, cadenceMs: 60, width: 3 },
	"braille-orbit": { frames: BRAILLE_ORBIT_FRAMES, cadenceMs: 100, width: 1 },
	"braille-breathe": { frames: BRAILLE_BREATHE_FRAMES, cadenceMs: 100, width: 1 },
	"braille-wave-rows": { frames: BRAILLE_WAVE_ROWS_FRAMES, cadenceMs: 90, width: 4 },
	"braille-checkerboard": { frames: BRAILLE_CHECKERBOARD_FRAMES, cadenceMs: 250, width: 3 },
	"braille-helix": { frames: BRAILLE_HELIX_FRAMES, cadenceMs: 80, width: 4 },
	scanline: { frames: SCANLINE_FRAMES, cadenceMs: 120, width: 3 },
	snake: { frames: SNAKE_FRAMES, cadenceMs: 80, width: 2 },
	"fill-sweep": { frames: FILL_SWEEP_FRAMES, cadenceMs: 100, width: 2 },
	"diagonal-swipe": { frames: DIAGONAL_SWIPE_FRAMES, cadenceMs: 60, width: 2 },
	dna: { frames: DNA_FRAMES, cadenceMs: 90, width: 3 },
	radar: { frames: RADAR_FRAMES, cadenceMs: 100, width: 3 },
	bounce: { frames: BOUNCE_FRAMES, cadenceMs: 110, width: 3 },
	orbit: { frames: ORBIT_FRAMES, cadenceMs: 100, width: 3 },
	conveyor: { frames: CONVEYOR_FRAMES, cadenceMs: 120, width: 3 },
	heartbeat: { frames: HEARTBEAT_FRAMES, cadenceMs: 110, width: 3 },
	"nerd-progress": { frames: NERD_PROGRESS_FRAMES, cadenceMs: 90, width: 1, nerdFonts: true },
	"nerd-morph": { frames: NERD_MORPH_FRAMES, cadenceMs: 180, width: 1, nerdFonts: true },
	"nerd-pipeline": { frames: NERD_PIPELINE_FRAMES, cadenceMs: 160, width: 3, nerdFonts: true },
	"nerd-pi-orbit": { frames: NERD_PI_ORBIT_FRAMES, cadenceMs: 140, width: 3, nerdFonts: true },
} satisfies Record<AnimatedMarkerStyle, MarkerAnimation>);

function markerAnimation(style: TuiActivityMarkerStyle): MarkerAnimation | undefined {
	if (style === "off" || style === "pulse" || style === "static") return undefined;
	return MARKER_ANIMATIONS[style];
}

/** Resolve a cyclic spinner frame without retaining animation state. */
export function spinnerFrame(
	elapsedMs: number,
	options: { frames?: readonly string[]; cadenceMs?: number; reducedMotion?: boolean } = {},
): string {
	return glyphFrame(options.frames ?? SPINNER_FRAMES, elapsedMs, options.cadenceMs ?? 80, options.reducedMotion);
}

/** Independently rendered activity marker and text. */
export interface ActivityFrame {
	marker: string;
	text: string;
}

/** Render the configured activity, optionally shimmering marker and text as one unit. */
export function activityFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: ActivityAnimationOverrides & {
		cadenceMs?: number;
		frames?: readonly string[];
		textTone?: TuiForegroundToken;
		highlightTone?: TuiForegroundToken;
		reducedMotion?: boolean;
	} = {},
): ActivityFrame {
	const appearance = getTuiAppearance();
	const configuredMarker = options.markerStyle ?? appearance.activityMarker;
	const markerStyle = options.reducedMotion && configuredMarker !== "off" ? "static" : configuredMarker;
	const shimmerStyle = options.reducedMotion ? "off" : (options.shimmerStyle ?? appearance.shimmer);
	const shimmerMarker = options.shimmerMarker ?? appearance.shimmerMarker;
	const animationElapsedMs = elapsedMs * animationSpeedMultiplier(options.animationSpeed ?? appearance.animationSpeed);
	const textTone = options.textTone ?? "text.primary";
	let markerGlyph: string;
	let marker: string;
	switch (markerStyle) {
		case "off":
			markerGlyph = "";
			marker = "";
			break;
		case "pulse":
			markerGlyph = "●";
			marker = pulseGlyphFrame(colors, markerGlyph, animationElapsedMs);
			break;
		case "static":
			markerGlyph = "●";
			marker = colors.fg("accent", markerGlyph);
			break;
		default: {
			const animation = markerAnimation(markerStyle);
			if (!animation) {
				markerGlyph = "";
				marker = "";
				break;
			}
			const configuredFrames = markerStyle === "spinner" ? (options.frames ?? animation.frames) : animation.frames;
			const frames =
				animation.nerdFrames && appearance.iconPack === "nerd-fonts"
					? animation.nerdFrames
					: animation.nerdFonts && appearance.iconPack !== "nerd-fonts"
						? fallbackFrames(animation.width)
						: configuredFrames;
			markerGlyph = activityGlyph(
				glyphFrame(frames, animationElapsedMs, options.cadenceMs ?? animation.cadenceMs),
				"-".repeat(animation.width),
				animation.width,
			);
			marker = colors.fg("accent", markerGlyph);
			break;
		}
	}
	const markerLength = textGraphemes(markerGlyph).length;
	const textLength = textGraphemes(text).length;
	const shimmerLength = markerLength + 1 + textLength;
	if (markerGlyph && shimmerMarker && shimmerStyle !== "off") {
		marker = paintShimmer(colors, markerGlyph, animationElapsedMs, shimmerStyle, {
			cadenceMs: options.cadenceMs,
			baseTone: "accent",
			highlightTone: options.highlightTone,
			variantAscii: true,
			offset: 0,
			totalLength: shimmerLength,
		});
	}
	const textOutput = paintShimmer(colors, text, animationElapsedMs, shimmerStyle, {
		cadenceMs: options.cadenceMs,
		baseTone: textTone,
		highlightTone: options.highlightTone,
		variantAscii: true,
		offset: markerGlyph && shimmerMarker ? markerLength + 1 : 0,
		totalLength: markerGlyph && shimmerMarker ? shimmerLength : textLength,
	});
	return { marker, text: textOutput };
}

function paintShimmer(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	style: TuiShimmerStyle,
	options: {
		cadenceMs?: number;
		baseTone: TuiForegroundToken;
		highlightTone?: TuiForegroundToken;
		variantAscii: boolean;
		offset: number;
		totalLength: number;
	},
): string {
	const cadenceMs = options.cadenceMs ?? shimmerCadenceMs(style);
	switch (style) {
		case "off":
			return colors.fg(options.baseTone, text);
		case "rainbow":
			return rainbowShimmerFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				offset: options.offset,
			});
		case "rainbow-glow":
			return rainbowGlowShimmerFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				offset: options.offset,
				totalLength: options.totalLength,
			});
		case "lightning":
			return lightningShimmerFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				variantAscii: options.variantAscii,
				offset: options.offset,
				totalLength: options.totalLength,
			});
		case "sweep":
		case "glow":
			return shimmerFrame(colors, text, elapsedMs, {
				cadenceMs,
				width: style === "sweep" ? 1 : 3,
				baseTone: options.baseTone,
				highlightTone: options.highlightTone,
				offset: options.offset,
				totalLength: options.totalLength,
			});
	}
}

function activityGlyph(value: string, fallback: string, width: MarkerWidth): string {
	const safe = sanitizeTuiText(value);
	return safe === value && safe.trim().length > 0 && visibleWidth(safe) === width ? safe : fallback;
}

function fallbackFrames(width: MarkerWidth): readonly string[] {
	return width === 1
		? LINE_FRAMES
		: width === 2
			? DOUBLE_LINE_FRAMES
			: width === 3
				? TRIPLE_LINE_FRAMES
				: QUADRUPLE_LINE_FRAMES;
}

/** Resolve a cyclic glyph frame without retaining animation state. */
export function glyphFrame(
	frames: readonly string[],
	elapsedMs: number,
	cadenceMs = 120,
	reducedMotion = false,
): string {
	if (frames.length === 0) return "";
	if (reducedMotion) return frames[0] ?? "";
	const cadence = Math.max(1, cadenceMs);
	return frames[Math.floor(Math.max(0, elapsedMs) / cadence) % frames.length] ?? "";
}

/** Resolve a triangular pulse value between caller-provided bounds. */
export function pulseFrame(
	elapsedMs: number,
	options: { periodMs?: number; low?: number; high?: number } = {},
): number {
	const period = Math.max(1, options.periodMs ?? 1_200);
	const low = options.low ?? 0;
	const high = options.high ?? 1;
	const phase = (Math.max(0, elapsedMs) % period) / period;
	return low + (1 - Math.abs(phase * 2 - 1)) * (high - low);
}

/** Paint a glyph with a semantic/harmonious glow according to a pure pulse frame. */
export function pulseGlyphFrame(
	colors: TuiTheme,
	glyph: string,
	elapsedMs: number,
	options: {
		periodMs?: number;
		baseTone?: TuiForegroundToken;
		highlightTone?: TuiForegroundToken;
		reducedMotion?: boolean;
	} = {},
): string {
	const baseTone = options.baseTone ?? "text.muted";
	if (options.reducedMotion) return colors.fg(baseTone, glyph);
	const highlightTone = options.highlightTone ?? "accent";
	const palette = glowPalette(highlightTone);
	const stops: readonly TuiForegroundColor[] = [
		baseTone,
		palette[3]!,
		palette[2]!,
		palette[1]!,
		highlightTone,
		palette[1]!,
		palette[2]!,
		palette[3]!,
		baseTone,
	];
	const position = Math.round(pulseFrame(elapsedMs, { periodMs: options.periodMs }) * (stops.length - 1));
	return colors.fg(stops[position] ?? baseTone, glyph);
}

/** Paint a moving semantic glow over text, grouping adjacent runs for low ANSI overhead. */
export function shimmerFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: {
		cadenceMs?: number;
		width?: number;
		baseTone?: TuiForegroundToken;
		highlightTone?: TuiForegroundToken;
		reducedMotion?: boolean;
		offset?: number;
		totalLength?: number;
	} = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	const highlightTone = options.highlightTone ?? "accent";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const shineWidth = Math.min(5, Math.max(1, Math.floor(options.width ?? 3)));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const cycle = totalLength + shineWidth;
	const position = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 70)) % cycle;
	const glow = glowPalette(highlightTone);
	let currentTone: TuiForegroundColor | undefined;
	let run = "";
	let output = "";
	for (const [index, character] of characters.entries()) {
		const distance = Math.abs(index + offset - position);
		const tone = distance <= shineWidth ? (glow[distance] ?? baseTone) : baseTone;
		if (currentTone !== undefined && tone !== currentTone) {
			output += colors.fg(currentTone, run);
			run = "";
		}
		currentTone = tone;
		run += character;
	}
	return `${output}${colors.fg(currentTone ?? baseTone, run)}`;
}

/** Paint a moving semantic rainbow wave over text, adapted from pi-animations' shimmer. */
export function rainbowShimmerFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: { cadenceMs?: number; baseTone?: TuiForegroundToken; reducedMotion?: boolean; offset?: number } = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const frame = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 80));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const hues: readonly TuiHue[] = ["magenta", "blue", "cyan", "green", "yellow", "red"];
	let output = "";
	for (const [index, character] of characters.entries()) {
		const globalIndex = index + offset;
		const wave = Math.sin((globalIndex - frame * 0.5) * 0.8);
		if (wave <= 0.3) {
			output += colors.fg(baseTone, character);
			continue;
		}
		const intensity = (wave - 0.3) / 0.7;
		const hue = hues[(globalIndex + Math.floor(frame / 2)) % hues.length] ?? "blue";
		const shade = Math.min(5, Math.max(2, Math.round(2 + intensity * 3))) as 2 | 3 | 4 | 5;
		output += colors.fg({ hue, shade }, character);
	}
	return output;
}

/** Paint a broad moving rainbow glow while retaining a subdued color trail. */
export function rainbowGlowShimmerFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: {
		cadenceMs?: number;
		baseTone?: TuiForegroundToken;
		reducedMotion?: boolean;
		offset?: number;
		totalLength?: number;
	} = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const frame = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 80));
	const hues: readonly TuiHue[] = ["magenta", "blue", "cyan", "green", "yellow", "red"];
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const position = frame % (totalLength + 5);
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			const distance = Math.abs(globalIndex - position);
			const hue = hues[(globalIndex + Math.floor(frame / 2)) % hues.length] ?? "blue";
			const shade = distance === 0 ? 5 : distance === 1 ? 4 : distance <= 3 ? 3 : 2;
			return colors.fg({ hue, shade }, character);
		})
		.join("");
}

const ASCII_ARTIFACT_MARKS = Object.freeze([
	"\u0307",
	"\u030c",
	"\u0302",
	"\u0304",
	"\u0323",
	"\u0327",
	"\u0303",
	"\u030a",
	"\u0338",
] as const);

const MAIN_ZIPPING_VARIANTS = Object.freeze({
	z: Object.freeze(["ż", "ž", "ẑ", "ẕ", "ẓ", "z̧", "z̃", "z̊", "z̸"]),
	i: Object.freeze(["i", "ǐ", "î", "ī", "ị", "į", "ĩ", "i̊", "i̸"]),
	n: Object.freeze(["ṅ", "ň", "n̂", "ṉ", "ṇ", "ņ", "ñ", "n̊", "n̸"]),
	g: Object.freeze(["ġ", "ǧ", "ĝ", "ḡ", "g̣", "ģ", "g̃", "g̊", "g̸"]),
} satisfies Readonly<Record<string, readonly string[]>>);

const ASCII_ARTIFACT_VARIANTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
	Object.fromEntries(
		Array.from({ length: 95 }, (_, offset) => {
			const character = String.fromCharCode(0x20 + offset);
			const exact = MAIN_ZIPPING_VARIANTS[character as keyof typeof MAIN_ZIPPING_VARIANTS];
			const variants = exact ?? ASCII_ARTIFACT_MARKS.map((mark) => `${character}${mark}`.normalize("NFC"));
			return [character, Object.freeze(variants)] as const;
		}),
	),
);

function artifactAsciiCharacter(character: string, frame: number): string {
	const variants = ASCII_ARTIFACT_VARIANTS[character];
	return variants?.[frame % variants.length] ?? character;
}

/**
 * Adapt main's fast-mode reverse strike and artifact variants to arbitrary text.
 * Every printable ASCII cell has nine fixed-width variants; main's z/i/n/g
 * table is retained exactly and the remaining cells use the same artifact families.
 */
export function lightningShimmerFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: {
		cadenceMs?: number;
		baseTone?: TuiForegroundToken;
		reducedMotion?: boolean;
		variantAscii?: boolean;
		offset?: number;
		totalLength?: number;
	} = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const cadenceMs = Math.max(1, options.cadenceMs ?? 60);
	const frame = Math.floor(Math.max(0, elapsedMs) / cadenceMs);
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const popIndex = totalLength - 1 - (Math.floor(frame / 2) % totalLength);
	const leftIndex = (popIndex + totalLength - 1) % totalLength;
	const rightIndex = (popIndex + 1) % totalLength;
	const shinePosition = ((frame * cadenceMs) / 80) % (totalLength + 3);
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			const varied = options.variantAscii === false ? character : artifactAsciiCharacter(character, frame);
			if (globalIndex === popIndex) return `\x1b[1;9m${colors.fg("warning", varied)}\x1b[22;29m`;
			if (globalIndex === leftIndex || globalIndex === rightIndex)
				return `\x1b[9m${colors.fg({ hue: "yellow", shade: 2 }, varied)}\x1b[29m`;
			const distance = shinePosition - globalIndex;
			if (distance > 0 && distance < 3) return colors.fg({ hue: glowHue(baseTone), shade: 4 }, varied);
			return colors.fg(baseTone, varied);
		})
		.join("");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function textGraphemes(text: string): string[] {
	return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function glowPalette(highlightTone: TuiForegroundToken): readonly TuiForegroundColor[] {
	const hue = glowHue(highlightTone);
	return [highlightTone, { hue, shade: 4 }, { hue, shade: 3 }, { hue, shade: 2 }, { hue, shade: 1 }];
}

function glowHue(tone: TuiForegroundToken): TuiHue {
	switch (tone) {
		case "positive":
			return "green";
		case "negative":
			return "red";
		case "warning":
		case "highlight":
			return "yellow";
		case "info":
			return "cyan";
		case "accent":
			return "blue";
		default:
			return "gray";
	}
}
