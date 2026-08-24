import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { tuiTheme } from "../src/color/theme.ts";
import type { MotionClock, MotionRenderTarget, MotionTimerHandle } from "../src/motion.ts";
import { glyphFrame, MotionScheduler, pulseFrame, pulseGlyphFrame, shimmerFrame, spinnerFrame } from "../src/motion.ts";

const theme = {
	name: "motion-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "accent" ? "\x1b[38;2;80;160;240m" : "\x1b[38;2;180;180;180m"),
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

interface FakeTimer extends MotionTimerHandle {
	callback: () => void;
	cadenceMs: number;
	unreferenced: boolean;
	stopped: boolean;
}

class FakeClock implements MotionClock {
	currentMs = 0;
	readonly timers: FakeTimer[] = [];

	now(): number {
		return this.currentMs;
	}

	start(callback: () => void, cadenceMs: number): FakeTimer {
		const timer: FakeTimer = {
			callback,
			cadenceMs,
			unreferenced: false,
			stopped: false,
			unref() {
				this.unreferenced = true;
			},
		};
		this.timers.push(timer);
		return timer;
	}

	stop(handle: MotionTimerHandle): void {
		(handle as FakeTimer).stopped = true;
	}

	tick(cadenceMs: number, nowMs: number): void {
		this.currentMs = nowMs;
		for (const timer of this.timers) {
			if (!timer.stopped && timer.cadenceMs === cadenceMs) timer.callback();
		}
	}
}

describe("MotionScheduler", () => {
	test("shares unreferenced cadence timers and releases them by reference count", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		const target = { requestRender() {} };
		const first = scheduler.mount(target, { cadenceMs: 80 });
		const second = scheduler.mount(target, { cadenceMs: 80 });

		expect(clock.timers).toHaveLength(1);
		expect(clock.timers[0]!.unreferenced).toBe(true);
		expect(scheduler.activeMountCount).toBe(2);
		let renders = 0;
		const coalescedTarget = { requestRender: () => renders++ };
		const third = scheduler.mount(coalescedTarget, { cadenceMs: 80 });
		const fourth = scheduler.mount(coalescedTarget, { cadenceMs: 80 });
		clock.tick(80, 80);
		expect(renders).toBe(1);
		first.dispose();
		expect(clock.timers[0]!.stopped).toBe(false);
		second.dispose();
		expect(clock.timers[0]!.stopped).toBe(false);
		third.dispose();
		fourth.dispose();
		expect(clock.timers[0]!.stopped).toBe(true);
		expect(scheduler.activeTimerCount).toBe(0);
	});

	test("coalesces target invalidation onto its fastest cadence while advancing slower callbacks", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		const frames: number[] = [];
		const target = { requestRender: () => renders++ };
		const fast = scheduler.mount(target, { cadenceMs: 40 });
		const slow = scheduler.mount(target, { cadenceMs: 100, onFrame: (now) => frames.push(now) });

		clock.tick(100, 100);
		expect(frames).toEqual([100]);
		expect(renders).toBe(0);
		clock.tick(40, 120);
		expect(renders).toBe(1);
		fast.dispose();
		clock.tick(100, 200);
		expect(renders).toBe(2);
		slow.dispose();
	});

	test("coalesces distinct component wrappers that share one host repaint callback", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		const requestRender = () => renders++;
		const first = scheduler.mount({ requestRender }, { cadenceMs: 80 });
		const second = scheduler.mount({ requestRender }, { cadenceMs: 80 });

		clock.tick(80, 80);

		expect(renders).toBe(1);
		first.dispose();
		second.dispose();
	});

	test("preserves the receiver of class-based render targets", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		class MethodTarget implements MotionRenderTarget {
			renders = 0;

			requestRender(): void {
				this.renders += 1;
			}
		}
		const target = new MethodTarget();
		const mount = scheduler.mount(target, { cadenceMs: 80 });

		clock.tick(80, 80);

		expect(target.renders).toBe(1);
		mount.dispose();
	});

	test("reduced motion allocates no timer", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		const mount = scheduler.mount({ requestRender() {} }, { cadenceMs: 40, reducedMotion: true });
		expect(scheduler.activeTimerCount).toBe(0);
		mount.dispose();
	});

	test("expires abandoned mounts without replaying stale animation frames", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		let frames = 0;
		const mount = scheduler.mount(
			{ requestRender: () => renders++ },
			{ cadenceMs: 40, maxDurationMs: 100, onFrame: () => frames++ },
		);

		clock.tick(40, 80);
		expect({ renders, frames }).toEqual({ renders: 1, frames: 1 });
		clock.tick(40, 100);
		expect({ renders, frames }).toEqual({ renders: 1, frames: 1 });
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
		expect(clock.timers[0]!.stopped).toBe(true);
		mount.dispose();
		expect(scheduler.activeMountCount).toBe(0);
	});

	test("normalizes invalid cadence and retires throwing callbacks", () => {
		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		scheduler.mount(
			{ requestRender: () => {} },
			{
				cadenceMs: Number.NaN,
				onFrame() {
					throw new Error("broken animation");
				},
			},
		);
		expect(clock.timers[0]!.cadenceMs).toBe(120);
		expect(() => clock.tick(120, 120)).not.toThrow();
		expect(scheduler.activeMountCount).toBe(0);
		expect(scheduler.activeTimerCount).toBe(0);
	});
});

describe("pure motion frames", () => {
	test("spinner and glyph frames are deterministic and freeze under reduced motion", () => {
		expect(spinnerFrame(160)).toBe(spinnerFrame(160));
		expect(glyphFrame(["a", "b"], 120, 100)).toBe("b");
		expect(glyphFrame(["a", "b"], 10_000, 100, true)).toBe("a");
	});

	test("pulse stays within caller bounds", () => {
		for (let now = 0; now < 10_000; now += 17) {
			const frame = pulseFrame(now, { low: 0.2, high: 0.8 });
			expect(frame).toBeGreaterThanOrEqual(0.2);
			expect(frame).toBeLessThanOrEqual(0.8);
		}
	});

	test("pulse uses multiple semantic and harmonious glow stops", () => {
		const colors = tuiTheme(theme);
		const frames = [0, 150, 300, 450, 600, 750, 900, 1_050].map((elapsedMs) => pulseGlyphFrame(colors, "●", elapsedMs));
		const foregrounds = new Set(frames.flatMap((frame) => frame.match(/\x1b\[38;[^m]+m/gu) ?? []));

		expect(foregrounds.size).toBeGreaterThan(2);
	});

	test("shimmer reaches the final cell and paints a multi-stop glow", () => {
		const colors = tuiTheme(theme);
		const text = "working";
		const cadenceMs = 70;
		const final = shimmerFrame(colors, text, (text.length - 1) * cadenceMs, { cadenceMs, width: 3 });
		const glow = shimmerFrame(colors, text, 3 * cadenceMs, { cadenceMs, width: 3 });

		expect(final).toContain(colors.fg("accent", "g"));
		expect(new Set(glow.match(/\x1b\[38;[^m]+m/gu) ?? []).size).toBeGreaterThan(2);
	});

	test("reduced motion keeps pulse and shimmer at their base tones", () => {
		const colors = tuiTheme(theme);
		expect(pulseGlyphFrame(colors, "●", 600, { reducedMotion: true })).toBe(colors.fg("text.muted", "●"));
		expect(shimmerFrame(colors, "working", 600, { reducedMotion: true })).toBe(colors.fg("text.secondary", "working"));
	});
});
