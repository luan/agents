import { visibleWidth } from "@earendil-works/pi-tui";
import {
	getTuiAppearance,
	subscribeTuiAppearance,
	type TuiActivityIndicatorStyle,
	type TuiAnimationSmoothness,
	type TuiAnimationSpeed,
	type TuiPulseEffectStyle,
	type TuiTextEffectStyle,
	type TuiTextEffectScope,
} from "./appearance.ts";
import type { TuiColor, TuiForegroundPaint, TuiForegroundToken, TuiHue, TuiTheme } from "./color/theme.ts";
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
	timer?: MotionTimerHandle;
	targets: Map<MotionRenderTarget, TargetRegistration>;
}

const systemClock: MotionClock = {
	now: () => performance.now(),
	start(callback, cadenceMs) {
		const handle: MotionTimerHandle & {
			cancelled: boolean;
			nextAtMs: number;
			timer?: ReturnType<typeof setTimeout>;
			unreferenced: boolean;
		} = {
			cancelled: false,
			nextAtMs: performance.now() + cadenceMs,
			unreferenced: false,
			unref() {
				this.unreferenced = true;
				this.timer?.unref?.();
			},
		};
		const schedule = (): void => {
			const delayMs = Math.max(0, handle.nextAtMs - performance.now());
			handle.timer = setTimeout(() => {
				if (handle.cancelled) return;
				callback();
				if (handle.cancelled) return;
				const nowMs = performance.now();
				const missed = Math.max(1, Math.floor((nowMs - handle.nextAtMs) / cadenceMs) + 1);
				handle.nextAtMs += missed * cadenceMs;
				schedule();
			}, delayMs);
			if (handle.unreferenced) handle.timer.unref?.();
		};
		schedule();
		return handle;
	},
	stop(handle) {
		const timer = handle as MotionTimerHandle & {
			cancelled: boolean;
			timer?: ReturnType<typeof setTimeout>;
		};
		timer.cancelled = true;
		if (timer.timer) clearTimeout(timer.timer);
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
	private paused = false;

	constructor(private readonly clock: MotionClock = systemClock) {}

	/** Register a target on a shared cadence bucket. */
	mount(target: MotionRenderTarget, options: MotionMountOptions): MotionMount {
		if (options.reducedMotion) return disposable(() => {});
		target = this.canonicalTarget(target);
		const cadenceMs = Number.isFinite(options.cadenceMs) ? Math.max(16, Math.floor(options.cadenceMs)) : 120;
		let bucket = this.buckets.get(cadenceMs);
		if (!bucket) {
			const targets = new Map<MotionRenderTarget, TargetRegistration>();
			bucket = { targets };
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
		if (!this.paused) this.startTimer(cadenceMs, bucket);
		this.mountCount++;
		return disposable(() => {
			const currentBucket = this.buckets.get(cadenceMs);
			const currentTarget = currentBucket?.targets.get(target);
			if (!currentBucket || !currentTarget?.registrations.delete(id)) return;
			this.mountCount--;
			if (currentTarget.registrations.size === 0) currentBucket.targets.delete(target);
			if (currentBucket.targets.size > 0) return;
			if (currentBucket.timer) this.clock.stop(currentBucket.timer);
			this.buckets.delete(cadenceMs);
		});
	}

	/** Suspend timers without discarding registrations, then resume their cadences intact. */
	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		for (const [cadenceMs, bucket] of this.buckets) {
			if (paused) {
				if (bucket.timer) this.clock.stop(bucket.timer);
				bucket.timer = undefined;
			} else {
				this.startTimer(cadenceMs, bucket);
			}
		}
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
		if (this.paused) return;
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
		if (bucket.timer) this.clock.stop(bucket.timer);
		this.buckets.delete(cadenceMs);
	}

	private startTimer(cadenceMs: number, bucket: CadenceBucket): void {
		if (bucket.timer || bucket.targets.size === 0) return;
		bucket.timer = this.clock.start(() => this.tick(cadenceMs, bucket.targets), cadenceMs);
		bucket.timer.unref?.();
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
		return [...this.buckets.values()].filter((bucket) => bucket.timer !== undefined).length;
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

	override setPaused(paused: boolean): void {
		resolveSharedMotionScheduler().setPaused(paused);
	}

	override get activeMountCount(): number {
		return resolveSharedMotionScheduler().activeMountCount;
	}
}

/** Process-wide cadence scheduler, initialized only when animation is used. */
export const sharedMotionScheduler: MotionScheduler = new SharedMotionScheduler();

/** Per-surface choices. Omitted values inherit the process-wide appearance. */
export interface ActivityAnimationOverrides {
	indicatorStyle?: TuiActivityIndicatorStyle;
	pulseEffectStyle?: TuiPulseEffectStyle;
	textEffectStyle?: TuiTextEffectStyle;
	textEffectScope?: TuiTextEffectScope;
	animationSpeed?: TuiAnimationSpeed;
	animationSmoothness?: TuiAnimationSmoothness;
}

/** Repaint cadence selected independently from animation pace. */
export function configuredAnimationCadenceMs(
	indicator = getTuiAppearance().activityIndicator,
	textEffect = getTuiAppearance().textEffect,
	smoothness: TuiAnimationSmoothness = getTuiAppearance().animationSmoothness,
	speed: TuiAnimationSpeed = getTuiAppearance().animationSpeed,
	pulseEffect: TuiPulseEffectStyle = getTuiAppearance().pulseEffect,
): number | undefined {
	const intrinsicCadenceMs = activityCadenceMs(indicator, textEffect, pulseEffect);
	if (intrinsicCadenceMs === undefined) return undefined;
	const designedCadenceMs = intrinsicCadenceMs / animationSpeedMultiplier(speed);
	return textEffect === "off"
		? Math.max(animationSmoothnessCadenceMs(smoothness), Math.ceil(designedCadenceMs))
		: animationSmoothnessCadenceMs(smoothness);
}

/** Timeline multiplier for one configured animation speed. */
export function animationSpeedMultiplier(speed: TuiAnimationSpeed = getTuiAppearance().animationSpeed): number {
	return speed === "slow" ? 0.6 : speed === "relaxed" ? 0.8 : speed === "fast" ? 1.35 : speed === "very-fast" ? 1.7 : 1;
}

/** Shared terminal repaint cadence for one configured smoothness. */
export function animationSmoothnessCadenceMs(
	smoothness: TuiAnimationSmoothness = getTuiAppearance().animationSmoothness,
): number {
	return smoothness === "economy" ? 80 : smoothness === "smooth" ? 22 : smoothness === "ultra" ? 16 : 33;
}

/** Whether the configured activity presentation animates its text. */
export function activityAnimatesText(style = getTuiAppearance().textEffect): boolean {
	return style !== "off";
}

function markerCadenceMs(style: TuiActivityIndicatorStyle): number | undefined {
	return markerAnimation(style)?.cadenceMs;
}

function shimmerCadenceMs(style: TuiTextEffectStyle): number | undefined {
	return style === "sweep"
		? 90
		: style === "glow"
			? 70
			: style === "rainbow" || style === "rainbow-glow" || style === "aurora"
				? 80
				: style === "lightning" || style === "glitch" || style === "crush"
					? 60
					: undefined;
}

function activityCadenceMs(
	indicator: TuiActivityIndicatorStyle,
	textEffect: TuiTextEffectStyle,
	pulseEffect: TuiPulseEffectStyle,
): number | undefined {
	const cadences = [
		markerCadenceMs(indicator),
		shimmerCadenceMs(textEffect),
		pulseEffect !== "off" ? 33 : undefined,
	].filter((cadence): cadence is number => cadence !== undefined);
	return cadences.length > 0 ? Math.min(...cadences) : undefined;
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
					options.indicatorStyle,
					options.textEffectStyle,
					options.animationSmoothness,
					options.animationSpeed,
					options.pulseEffectStyle,
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

type AnimatedMarkerStyle = Exclude<TuiActivityIndicatorStyle, "off" | "static">;

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

function markerAnimation(style: TuiActivityIndicatorStyle): MarkerAnimation | undefined {
	if (style === "off" || style === "static") return undefined;
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
	const configuredMarker = options.indicatorStyle ?? appearance.activityIndicator;
	const indicatorStyle = options.reducedMotion && configuredMarker !== "off" ? "static" : configuredMarker;
	const textEffectStyle = options.reducedMotion ? "off" : (options.textEffectStyle ?? appearance.textEffect);
	const pulseEffectStyle = options.reducedMotion ? "off" : (options.pulseEffectStyle ?? appearance.pulseEffect);
	const textEffectScope = options.textEffectScope ?? appearance.textEffectScope;
	const speedMultiplier = animationSpeedMultiplier(options.animationSpeed ?? appearance.animationSpeed);
	const animationElapsedMs = elapsedMs * speedMultiplier;
	const sampleCadenceMs =
		animationSmoothnessCadenceMs(options.animationSmoothness ?? appearance.animationSmoothness) * speedMultiplier;
	const textTone = options.textTone ?? (textEffectStyle === "off" ? "text.primary" : "text.muted");
	const paint =
		pulseEffectStyle === "pulse"
			? brightnessPulsingTheme(colors, animationElapsedMs)
			: pulseEffectStyle === "color"
				? colorPulsingTheme(colors, animationElapsedMs)
				: colors;
	let markerGlyph: string;
	let marker: string;
	switch (indicatorStyle) {
		case "off":
			markerGlyph = "";
			marker = "";
			break;
		case "static":
			markerGlyph = "●";
			marker = paint.fg("accent", markerGlyph);
			break;
		default: {
			const animation = markerAnimation(indicatorStyle);
			if (!animation) {
				markerGlyph = "";
				marker = "";
				break;
			}
			const configuredFrames = indicatorStyle === "spinner" ? (options.frames ?? animation.frames) : animation.frames;
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
			marker = paint.fg("accent", markerGlyph);
			break;
		}
	}
	const markerLength = textGraphemes(markerGlyph).length;
	const textLength = textGraphemes(text).length;
	const shimmerLength = markerLength + 1 + textLength;
	if (markerGlyph && textEffectScope === "inline" && textEffectStyle !== "off") {
		marker = paintShimmer(paint, markerGlyph, animationElapsedMs, textEffectStyle, {
			cadenceMs: options.cadenceMs,
			baseTone: textTone,
			highlightTone: options.highlightTone,
			variantAscii: true,
			sampleCadenceMs,
			offset: 0,
			totalLength: shimmerLength,
		});
	}
	const textOutput = paintShimmer(paint, text, animationElapsedMs, textEffectStyle, {
		cadenceMs: options.cadenceMs,
		baseTone: textTone,
		highlightTone: options.highlightTone,
		variantAscii: true,
		sampleCadenceMs,
		offset: markerGlyph && textEffectScope === "inline" ? markerLength + 1 : 0,
		totalLength: markerGlyph && textEffectScope === "inline" ? shimmerLength : textLength,
	});
	return { marker, text: textOutput };
}

function paintShimmer(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	style: TuiTextEffectStyle,
	options: {
		cadenceMs?: number;
		baseTone: TuiForegroundToken;
		highlightTone?: TuiForegroundToken;
		variantAscii: boolean;
		sampleCadenceMs: number;
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
				variantCadenceMs: options.sampleCadenceMs,
				offset: options.offset,
				totalLength: options.totalLength,
			});
		case "aurora":
			return auroraTextEffectFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				offset: options.offset,
			});
		case "glitch":
			return glitchTextEffectFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				offset: options.offset,
			});
		case "crush":
			return crushTextEffectFrame(colors, text, elapsedMs, {
				cadenceMs,
				baseTone: options.baseTone,
				offset: options.offset,
				totalLength: options.totalLength,
			});
		case "sweep":
			return shimmerFrame(colors, text, elapsedMs, {
				cadenceMs,
				width: 1,
				baseTone: options.baseTone,
				highlightTone: options.highlightTone,
				offset: options.offset,
				totalLength: options.totalLength,
				profile: "linear",
			});
		case "glow":
			return shimmerFrame(colors, text, elapsedMs, {
				baseTone: options.baseTone,
				highlightTone: options.highlightTone,
				offset: options.offset,
				totalLength: options.totalLength,
				profile: "cosine",
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

/** Resolve a cosine-eased pulse value between caller-provided bounds. */
export function pulseFrame(
	elapsedMs: number,
	options: { periodMs?: number; low?: number; high?: number } = {},
): number {
	const period = Math.max(1, options.periodMs ?? 1_200);
	const low = options.low ?? 0;
	const high = options.high ?? 1;
	const phase = (Math.max(0, elapsedMs) % period) / period;
	return low + (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)) * (high - low);
}

const EFFECT_CONTRAST_CANDIDATES = Object.freeze([
	"accent",
	"highlight",
	"info",
	"positive",
	"warning",
	"negative",
	"text.primary",
] as const satisfies readonly TuiForegroundPaint[]);

function adaptiveEffectHighlight(colors: TuiTheme, base: TuiForegroundPaint): TuiColor {
	return colors.strongestForegroundContrast(base, EFFECT_CONTRAST_CANDIDATES);
}

function transformedForegroundTheme(colors: TuiTheme, transform: (paint: TuiForegroundPaint) => TuiColor): TuiTheme {
	return {
		color: colors.color,
		mixForeground: colors.mixForeground,
		adjustForegroundBrightness: colors.adjustForegroundBrightness,
		fg: (paint, text) => colors.fg(transform(paint), text),
		bg: colors.bg,
		fgAnsi: (paint) => colors.fgAnsi(transform(paint)),
		bgAnsi: colors.bgAnsi,
		contrastBackground: colors.contrastBackground,
		strongestForegroundContrast: colors.strongestForegroundContrast,
	};
}

/** Compose a cosine dim-to-bright pulse over every foreground painted by another activity effect. */
function brightnessPulsingTheme(colors: TuiTheme, elapsedMs: number): TuiTheme {
	const amount = pulseFrame(elapsedMs, { low: -0.4, high: 0.18 });
	return transformedForegroundTheme(colors, (paint) => colors.adjustForegroundBrightness(paint, amount));
}

/** Compose a cosine color pulse over every foreground painted by another activity effect. */
function colorPulsingTheme(colors: TuiTheme, elapsedMs: number): TuiTheme {
	const amount = pulseFrame(elapsedMs, { low: 0.05, high: 0.55 });
	return transformedForegroundTheme(colors, (paint) =>
		colors.mixForeground(paint, adaptiveEffectHighlight(colors, paint), amount),
	);
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
	const highlightTone = options.highlightTone ?? adaptiveEffectHighlight(colors, baseTone);
	return colors.fg(
		colors.mixForeground(baseTone, highlightTone, pulseFrame(elapsedMs, { periodMs: options.periodMs })),
		glyph,
	);
}

/** Paint a moving semantic glow over text, grouping adjacent runs for low ANSI overhead. */
export function shimmerFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: {
		cadenceMs?: number;
		width?: number;
		profile?: "cosine" | "linear";
		baseTone?: TuiForegroundPaint;
		highlightTone?: TuiForegroundPaint;
		reducedMotion?: boolean;
		offset?: number;
		totalLength?: number;
	} = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	const highlightTone = options.highlightTone ?? adaptiveEffectHighlight(colors, baseTone);
	if (options.reducedMotion) return colors.fg(baseTone, text);
	if ((options.profile ?? "cosine") === "cosine")
		return cosineShimmerFrame(colors, characters, elapsedMs, {
			baseTone,
			highlightTone,
			offset: options.offset,
			totalLength: options.totalLength,
		});
	const shineWidth = Math.min(5, Math.max(1, Math.floor(options.width ?? 3)));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const cycle = totalLength + shineWidth;
	const position = (Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 70)) % cycle;
	const glow = glowPalette(colors, baseTone, highlightTone);
	let currentTone: TuiForegroundPaint | undefined;
	let run = "";
	let output = "";
	for (const [index, character] of characters.entries()) {
		const distance = Math.abs(index + offset - position);
		const glowIndex = Math.min(glow.length - 1, Math.floor((distance / shineWidth) * glow.length));
		const tone = distance <= shineWidth ? (glow[glowIndex] ?? baseTone) : baseTone;
		if (currentTone !== undefined && tone !== currentTone) {
			output += colors.fg(currentTone, run);
			run = "";
		}
		currentTone = tone;
		run += character;
	}
	return `${output}${colors.fg(currentTone ?? baseTone, run)}`;
}

const COSINE_SHIMMER_SPEED_CELLS_PER_SECOND = 30;
const COSINE_SHIMMER_PADDING = 10;
const COSINE_SHIMMER_HALF_WIDTH = 6;

/** Port oh-my-pi's fixed-velocity cosine shimmer over one continuous activity unit. */
function cosineShimmerFrame(
	colors: TuiTheme,
	characters: readonly string[],
	elapsedMs: number,
	options: {
		baseTone: TuiForegroundPaint;
		highlightTone: TuiForegroundPaint;
		offset?: number;
		totalLength?: number;
	},
): string {
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const period = totalLength + COSINE_SHIMMER_PADDING * 2;
	const position = ((Math.max(0, elapsedMs) / 1_000) * COSINE_SHIMMER_SPEED_CELLS_PER_SECOND) % period;
	let run = "";
	let runColor: TuiColor | undefined;
	let runBold = false;
	let output = "";
	const flush = (): void => {
		if (!run || runColor === undefined) return;
		const painted = colors.fg(runColor, run);
		output += runBold ? `\x1b[1m${painted}\x1b[22m` : painted;
		run = "";
	};
	for (const [index, character] of characters.entries()) {
		const distance = Math.abs(index + offset + COSINE_SHIMMER_PADDING - position);
		const intensity =
			distance >= COSINE_SHIMMER_HALF_WIDTH
				? 0
				: 0.5 * (1 + Math.cos((Math.PI * distance) / COSINE_SHIMMER_HALF_WIDTH));
		const color = colors.mixForeground(options.baseTone, options.highlightTone, intensity);
		const bold = intensity >= 0.65;
		if (runColor !== undefined && (colors.fgAnsi(runColor) !== colors.fgAnsi(color) || runBold !== bold)) flush();
		runColor = color;
		runBold = bold;
		run += character;
	}
	flush();
	return output;
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
	const frame = Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 80);
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
	const frame = Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 80);
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

/** Paint the distinct magenta-blue-cyan wave formerly bundled as a status-row replacement. */
export function auroraTextEffectFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: { cadenceMs?: number; baseTone?: TuiForegroundToken; reducedMotion?: boolean; offset?: number } = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const frame = Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 80);
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const hues: readonly TuiHue[] = ["magenta", "blue", "cyan"];
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			const wave = Math.sin((globalIndex - frame * 0.3) * 0.8);
			if (wave <= 0.3) return colors.fg(baseTone, character);
			const hue = hues[Math.floor(globalIndex + frame * 0.5) % hues.length] ?? "blue";
			const painted = colors.fg(
				{ hue, shade: Math.max(3, Math.min(5, Math.round(3 + wave * 2))) as 3 | 4 | 5 },
				character,
			);
			return `\x1b[1m${painted}\x1b[22m`;
		})
		.join("");
}

const GLITCH_GLYPHS = "█▓▒░╳╱╲¥£€$#@!?&%~*";

/** Briefly replace isolated message cells with deterministic cyberpunk artifacts. */
export function glitchTextEffectFrame(
	colors: TuiTheme,
	text: string,
	elapsedMs: number,
	options: { cadenceMs?: number; baseTone?: TuiForegroundToken; reducedMotion?: boolean; offset?: number } = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const frame = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 60));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			const roll = deterministicUnit(globalIndex * 3 + frame, Math.floor(frame / 2));
			if (roll >= 0.18) return colors.fg(baseTone, character);
			const glyph = GLITCH_GLYPHS[(globalIndex + frame) % GLITCH_GLYPHS.length] ?? character;
			return colors.fg(
				roll < 0.12 ? { hue: (["cyan", "magenta", "blue", "yellow"] as const)[globalIndex % 4]!, shade: 5 } : "accent",
				glyph,
			);
		})
		.join("");
}

const CRUSH_GLYPHS = "0123456789abcdefABCDEF~!@#$£€%^&*()+=_";

/** Resolve a moving field of artifact cells back into the original message. */
export function crushTextEffectFrame(
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
	const frame = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 60));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const head = frame % (totalLength + 8);
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			if (globalIndex < head - 2) return colors.fg(baseTone, character);
			const glyph = CRUSH_GLYPHS[(globalIndex + frame) % CRUSH_GLYPHS.length] ?? character;
			return colors.fg({ hue: (["magenta", "blue", "cyan"] as const)[globalIndex % 3]!, shade: 4 }, glyph);
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
		variantCadenceMs?: number;
		offset?: number;
		totalLength?: number;
	} = {},
): string {
	const characters = textGraphemes(text);
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const cadenceMs = Math.max(1, options.cadenceMs ?? 60);
	const timeline = Math.max(0, elapsedMs) / cadenceMs;
	const frame = Math.floor(timeline);
	const artifactFrame = Math.round(Math.max(0, elapsedMs) / Math.max(1, options.variantCadenceMs ?? cadenceMs));
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const totalLength = Math.max(offset + characters.length, Math.floor(options.totalLength ?? characters.length));
	const popIndex = totalLength - 1 - (Math.floor(frame / 2) % totalLength);
	const leftIndex = (popIndex + totalLength - 1) % totalLength;
	const rightIndex = (popIndex + 1) % totalLength;
	const shinePosition = (Math.max(0, elapsedMs) / 80) % (totalLength + 3);
	return characters
		.map((character, index) => {
			const globalIndex = index + offset;
			const varied = options.variantAscii === false ? character : artifactAsciiCharacter(character, artifactFrame);
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

function glowPalette(
	colors: TuiTheme,
	baseTone: TuiForegroundPaint,
	highlightTone: TuiForegroundPaint,
): readonly TuiForegroundPaint[] {
	return [
		highlightTone,
		colors.mixForeground(baseTone, highlightTone, 0.8),
		colors.mixForeground(baseTone, highlightTone, 0.6),
		colors.mixForeground(baseTone, highlightTone, 0.4),
		colors.mixForeground(baseTone, highlightTone, 0.2),
	];
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

function deterministicUnit(seed: number, frame: number): number {
	const value = Math.sin(seed * 12.9898 + frame * 78.233) * 43_758.5453;
	return value - Math.floor(value);
}
