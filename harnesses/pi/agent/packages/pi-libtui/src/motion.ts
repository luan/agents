import type { TuiForegroundColor, TuiForegroundToken, TuiHue, TuiTheme } from "./color/theme.ts";

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

/** Portable braille spinner frames. */
export const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const);

/** Resolve a cyclic spinner frame without retaining animation state. */
export function spinnerFrame(
	elapsedMs: number,
	options: { frames?: readonly string[]; cadenceMs?: number; reducedMotion?: boolean } = {},
): string {
	return glyphFrame(options.frames ?? SPINNER_FRAMES, elapsedMs, options.cadenceMs ?? 80, options.reducedMotion);
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
	} = {},
): string {
	const characters = [...text];
	if (characters.length === 0) return "";
	const baseTone = options.baseTone ?? "text.secondary";
	const highlightTone = options.highlightTone ?? "accent";
	if (options.reducedMotion) return colors.fg(baseTone, text);
	const shineWidth = Math.min(5, Math.max(1, Math.floor(options.width ?? 3)));
	const cycle = characters.length + shineWidth;
	const position = Math.floor(Math.max(0, elapsedMs) / Math.max(1, options.cadenceMs ?? 70)) % cycle;
	const glow = glowPalette(highlightTone);
	let currentTone: TuiForegroundColor | undefined;
	let run = "";
	let output = "";
	for (const [index, character] of characters.entries()) {
		const distance = Math.abs(index - position);
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
