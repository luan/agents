export type Rgb = [number, number, number];

export interface ThemeColorSource {
	fg(role: string, text: string): string;
	getFgAnsi?(role: string): string | undefined;
}

interface ShineTextOptions {
	role?: string;
	baseScale?: number;
	shineScale?: number;
	shineWidth?: number;
	percolationMs?: number;
	fallback?: (text: string) => string;
}

interface PulseGlyphOptions {
	role?: string;
	periodMs?: number;
	lowScale?: number;
	highScale?: number;
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUNNING_FRAME_MS = 120;
const DEFAULT_SHINE_WIDTH = 3;
const DEFAULT_PERCOLATION_MS = 80;
const RGB_FALLBACK: Rgb = [0xff, 0xff, 0xff];
const ansiByTheme = new WeakMap<ThemeColorSource, Map<string, string | undefined>>();
const rgbByTheme = new WeakMap<ThemeColorSource, Map<string, Rgb>>();

export function runningFrame(elapsedMs: number | undefined, frameMs = RUNNING_FRAME_MS): string {
	if (elapsedMs === undefined) return RUNNING_FRAMES[0]!;
	return RUNNING_FRAMES[Math.floor(elapsedMs / frameMs) % RUNNING_FRAMES.length]!;
}

/**
 * A tool call's cell stays "running" until the call reports a terminal state, so one abandoned
 * mid-stream animates for the rest of the session. That is not merely a wasted timer: once the cell
 * scrolls above the viewport, pi-tui answers a changed line outside the visible range by clearing
 * the screen and scrollback and re-emitting the whole transcript. A spinner nobody can see then
 * costs a full-screen repaint several times a second. Freezing the clock past this point makes a
 * stalled cell render identically frame to frame, so the differ finds nothing to repaint.
 *
 * ponytail: a wall-clock cap, not real stall detection. A genuinely slow call just stops spinning
 * once past it. Key off a real "arguments finished streaming" signal if a tool exposes one.
 */
export const RUNNING_ANIMATION_MAX_MS = 60_000;

/** Spinner clock for a running cell, frozen once the call has clearly stalled. */
export function cappedRunningElapsedMs(startedAtMs: number): number {
	return Math.min(Date.now() - startedAtMs, RUNNING_ANIMATION_MAX_MS);
}

/** True once a running cell's clock has hit the cap, i.e. stop scheduling further frames. */
export function runningAnimationStalled(elapsedMs: number | undefined): boolean {
	return elapsedMs !== undefined && elapsedMs >= RUNNING_ANIMATION_MAX_MS;
}

/**
 * Resume replays the transcript before any turn runs, and a replayed call that never got a result
 * is stuck `isPartial` forever with `argsComplete` and `executionStarted` both still false — pi only
 * sets those from live stream events. That makes a dead history cell indistinguishable from a live
 * one by its flags alone, so track liveness ourselves: anything first rendered before this process
 * streamed a turn is history and must never animate. Without this, the stall cap below still lets a
 * resumed session flicker for a full minute, because a fresh render state restarts its clock.
 */
let liveTurnStarted = false;

/** Wire to a live-stream lifecycle event so replayed history can be told apart from live calls. */
export function markLiveTurnStarted(): void {
	liveTurnStarted = true;
}

/** Test seam: forget that a live turn ran. */
export function resetLiveTurnForTests(): void {
	liveTurnStarted = false;
}

type RunningCellState = { startedAtMs?: number; replayed?: boolean };

/** Records once, on a cell's first render, whether it came from replayed history. */
function isReplayed(state: RunningCellState): boolean {
	state.replayed ??= !liveTurnStarted;
	return state.replayed;
}

/**
 * Spinner clock for a running cell: `undefined` when not running, frozen at frame 0 for replayed
 * history, and capped once a live call stalls. Freezing matters because pi-tui answers any changed
 * line above the viewport by clearing the screen and scrollback and re-emitting the whole
 * transcript — so an animating cell nobody can see costs a full-screen repaint per frame.
 */
export function runningCellElapsedMs(state: RunningCellState | undefined, running: boolean): number | undefined {
	if (!running || !state) return undefined;
	if (isReplayed(state)) return 0;
	state.startedAtMs ??= Date.now();
	return cappedRunningElapsedMs(state.startedAtMs);
}

/** Whether a running cell should schedule another animation frame. */
export function shouldAnimateRunningCell(state: RunningCellState | undefined, running: boolean): boolean {
	if (!running || !state) return false;
	if (isReplayed(state)) return false;
	state.startedAtMs ??= Date.now();
	return !runningAnimationStalled(cappedRunningElapsedMs(state.startedAtMs));
}

export function shineText(
	theme: ThemeColorSource,
	text: string,
	elapsedMs: number | undefined,
	options: ShineTextOptions = {},
): string {
	const role = options.role ?? "accent";
	if (!themeRoleAnsi(theme, role)) return options.fallback?.(text) ?? text;
	const base = scaleRgb(themeRoleToRgb(theme, role), options.baseScale ?? 0.55);
	const shine = scaleRgb(themeRoleToRgb(theme, role), options.shineScale ?? 1.55);
	const chars = [...text];
	const shineWidth = options.shineWidth ?? DEFAULT_SHINE_WIDTH;
	const step = Math.floor((elapsedMs ?? 0) / (options.percolationMs ?? DEFAULT_PERCOLATION_MS));
	const cycle = chars.length + shineWidth;
	const pos = step % cycle;
	return `${chars
		.map((ch, index) => {
			const inShine = index >= pos - shineWidth && index < pos;
			return `${rgbFg(inShine ? shine : base)}${ch}`;
		})
		.join("")}\x1b[39m`;
}

export function pulseGlyph(
	theme: ThemeColorSource,
	glyph: string,
	elapsedMs: number | undefined,
	options: PulseGlyphOptions = {},
): string {
	const role = options.role ?? "accent";
	if (!themeRoleAnsi(theme, role)) return theme.fg(role, glyph);
	const color = scaleRgb(
		themeRoleToRgb(theme, role),
		triangleWave(elapsedMs ?? 0, options.periodMs ?? 1_200, options.lowScale ?? 0.45, options.highScale ?? 1.45),
	);
	return `${rgbFg(color)}${glyph}\x1b[39m`;
}

export function triangleWave(elapsedMs: number, periodMs: number, lo: number, hi: number): number {
	const t = (elapsedMs % periodMs) / periodMs;
	const tri = 1 - Math.abs(2 * t - 1);
	return lo + tri * (hi - lo);
}

export function themeRoleAnsi(theme: ThemeColorSource, role: string): string | undefined {
	const hex = parseHexRgb(role);
	if (hex) return rgbFg(hex);
	let cache = ansiByTheme.get(theme);
	if (!cache) {
		cache = new Map();
		ansiByTheme.set(theme, cache);
	}
	if (cache.has(role)) return cache.get(role);
	const ansi = theme.getFgAnsi
		? theme.getFgAnsi(role)
		: (() => {
				const sample = theme.fg(role, "x");
				const marker = sample.indexOf("x");
				const prefix = marker >= 0 ? sample.slice(0, marker) : undefined;
				return prefix?.includes("\x1b[38;") ? prefix : undefined;
			})();
	cache.set(role, ansi);
	return ansi;
}

export function themeRoleToRgb(theme: ThemeColorSource, role: string): Rgb {
	const hex = parseHexRgb(role);
	if (hex) return hex;
	let cache = rgbByTheme.get(theme);
	if (!cache) {
		cache = new Map();
		rgbByTheme.set(theme, cache);
	}
	const cached = cache.get(role);
	if (cached) return cached;
	const ansi = themeRoleAnsi(theme, role);
	const truecolor = ansi?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	const color256 = ansi?.match(/\x1b\[38;5;(\d+)m/);
	const rgb = truecolor
		? ([Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])] as Rgb)
		: color256
			? ansi256ToRgb(Number(color256[1]))
			: RGB_FALLBACK;
	cache.set(role, rgb);
	return rgb;
}

export function scaleRgb([r, g, b]: Rgb, factor: number): Rgb {
	const scale = (value: number) => Math.round(Math.max(0, Math.min(255, value * factor)));
	return [scale(r), scale(g), scale(b)];
}

export function rgbFg([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}
export function rgbBg([r, g, b]: Rgb): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

export function parseHexRgb(color: string): Rgb | undefined {
	const match = color.match(/^#?([0-9a-fA-F]{6})$/);
	if (!match) return undefined;
	const hex = match[1]!;
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

export function ansiFgToRgb(ansi: string | undefined): Rgb | undefined {
	if (!ansi) return undefined;
	const truecolor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const color256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	if (color256) return ansi256ToRgb(Number(color256[1]));
	const basic = ansi.match(/\x1b\[(\d+)m/);
	if (basic) return basicAnsiToRgb(Number(basic[1]));
	return undefined;
}

function basicAnsiToRgb(code: number): Rgb | undefined {
	const normal: Record<number, Rgb> = {
		30: [0, 0, 0],
		31: [128, 0, 0],
		32: [0, 128, 0],
		33: [128, 128, 0],
		34: [0, 0, 128],
		35: [128, 0, 128],
		36: [0, 128, 128],
		37: [192, 192, 192],
		90: [128, 128, 128],
		91: [255, 0, 0],
		92: [0, 255, 0],
		93: [255, 255, 0],
		94: [0, 0, 255],
		95: [255, 0, 255],
		96: [0, 255, 255],
		97: [255, 255, 255],
	};
	return normal[code];
}

function ansi256ToRgb(code: number): Rgb {
	if (code < 16) {
		const base: Rgb[] = [
			[0, 0, 0],
			[128, 0, 0],
			[0, 128, 0],
			[128, 128, 0],
			[0, 0, 128],
			[128, 0, 128],
			[0, 128, 128],
			[192, 192, 192],
			[128, 128, 128],
			[255, 0, 0],
			[0, 255, 0],
			[255, 255, 0],
			[0, 0, 255],
			[255, 0, 255],
			[0, 255, 255],
			[255, 255, 255],
		];
		return base[code] ?? RGB_FALLBACK;
	}
	if (code >= 16 && code <= 231) {
		const n = code - 16;
		const r = Math.floor(n / 36);
		const g = Math.floor((n % 36) / 6);
		const b = n % 6;
		const scale = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [scale(r), scale(g), scale(b)];
	}
	const gray = 8 + (code - 232) * 10;
	return [gray, gray, gray];
}

interface AnimationMountOptions {
	id: string;
	intervalMs: number;
	onFrame(frame: number): void;
}

export interface AnimationMount {
	dispose(): void;
}

export interface AnimationRenderTarget {
	requestRender(): void;
}

interface AnimationRenderRegistration {
	count: number;
	onFrames: Set<() => void>;
}

interface AnimationRenderBucket {
	timer: ReturnType<typeof setInterval>;
	targets: Map<AnimationRenderTarget, AnimationRenderRegistration>;
}

export class AnimationRenderScheduler {
	private buckets = new Map<number, AnimationRenderBucket>();

	constructor(
		private startTimer: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval> = (
			callback,
			intervalMs,
		) => setInterval(callback, intervalMs),
		private stopTimer: (timer: ReturnType<typeof setInterval>) => void = (timer) => clearInterval(timer),
	) {}

	mount(target: AnimationRenderTarget, intervalMs: number, onFrame?: () => void): AnimationMount {
		let bucket = this.buckets.get(intervalMs);
		if (!bucket) {
			const targets = new Map<AnimationRenderTarget, AnimationRenderRegistration>();
			const timer = this.startTimer(() => {
				for (const [current, registration] of targets) {
					for (const callback of registration.onFrames) callback();
					current.requestRender();
				}
			}, intervalMs);
			timer.unref?.();
			bucket = { timer, targets };
			this.buckets.set(intervalMs, bucket);
		}
		const registration = bucket.targets.get(target) ?? { count: 0, onFrames: new Set() };
		registration.count++;
		if (onFrame) registration.onFrames.add(onFrame);
		bucket.targets.set(target, registration);
		let disposed = false;
		return {
			dispose: () => {
				if (disposed) return;
				disposed = true;
				if (onFrame) registration.onFrames.delete(onFrame);
				registration.count--;
				if (registration.count > 0) return;
				bucket.targets.delete(target);
				if (bucket.targets.size > 0) return;
				this.stopTimer(bucket.timer);
				this.buckets.delete(intervalMs);
			},
		};
	}

	get activeTimerCount(): number {
		return this.buckets.size;
	}
}

export const sharedAnimationRenderScheduler = new AnimationRenderScheduler();
interface AnimationEntry extends AnimationMountOptions {
	frame: number;
	nextFrameAt?: number;
}

export class AnimationScheduler {
	private entries = new Map<string, AnimationEntry>();

	mount(options: AnimationMountOptions): AnimationMount {
		this.entries.set(options.id, { ...options, frame: 0 });
		return {
			dispose: () => {
				this.entries.delete(options.id);
			},
		};
	}

	nextDelay(now: number): number | undefined {
		for (const entry of this.entries.values()) {
			entry.nextFrameAt ??= now + entry.intervalMs;
		}
		const next = this.nextFrameAt(now);
		return next === undefined ? undefined : Math.max(0, next - now);
	}

	tick(now: number): void {
		for (const entry of this.entries.values()) {
			entry.nextFrameAt ??= now + entry.intervalMs;
			if (now < entry.nextFrameAt) continue;
			entry.frame++;
			entry.nextFrameAt = now + entry.intervalMs;
			entry.onFrame(entry.frame);
		}
	}

	private nextFrameAt(now: number): number | undefined {
		let next: number | undefined;
		for (const entry of this.entries.values()) {
			const candidate = entry.nextFrameAt ?? now + entry.intervalMs;
			next = next === undefined ? candidate : Math.min(next, candidate);
		}
		return next;
	}
}
