import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";
import type { MotionClock, MotionRenderTarget, MotionTimerHandle } from "../src/motion.ts";
import {
	activityFrame,
	configuredAnimationCadenceMs,
	glyphFrame,
	mountConfiguredAnimation,
	MotionScheduler,
	pulseFrame,
	pulseGlyphFrame,
	rainbowShimmerFrame,
	shimmerFrame,
	spinnerFrame,
} from "../src/motion.ts";

const theme = {
	name: "motion-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "accent" ? "\x1b[38;2;80;160;240m" : "\x1b[38;2;180;180;180m"),
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

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
	test("renders activity text independently from optional markers", () => {
		const colors = tuiTheme(theme);
		const spinner = activityFrame(colors, "Working", 0, { markerStyle: "spinner", shimmerStyle: "off" });
		const pulseGlow = activityFrame(colors, "Working", 140, { markerStyle: "pulse", shimmerStyle: "glow" });
		const markerlessSweep = activityFrame(colors, "Working", 140, { markerStyle: "off", shimmerStyle: "sweep" });
		const staticGlow = activityFrame(colors, "Working", 140, { markerStyle: "static", shimmerStyle: "glow" });
		const lineRainbow = activityFrame(colors, "Working", 140, { markerStyle: "line", shimmerStyle: "rainbow" });
		const arc = activityFrame(colors, "Working", 160, { markerStyle: "arc", shimmerStyle: "off" });
		const dots = activityFrame(colors, "Working", 240, { markerStyle: "dots", shimmerStyle: "off" });
		const quadrants = activityFrame(colors, "Working", 200, { markerStyle: "quadrants", shimmerStyle: "off" });
		const sparkle = activityFrame(colors, "Working", 240, { markerStyle: "sparkle", shimmerStyle: "off" });
		const staticFrame = activityFrame(colors, "Working", 10_000, { markerStyle: "static", shimmerStyle: "off" });

		expect(Bun.stripANSI(spinner.marker)).toBe("⠋");
		expect(Bun.stripANSI(pulseGlow.marker)).toBe("●");
		expect(markerlessSweep.marker).toBe("");
		expect(Bun.stripANSI(markerlessSweep.text)).toBe("Working");
		expect(Bun.stripANSI(staticGlow.marker)).toBe("●");
		expect(["-", "\\", "|", "/"]).toContain(Bun.stripANSI(lineRainbow.marker));
		expect(Bun.stripANSI(arc.marker)).toBe("◠");
		expect(Bun.stripANSI(dots.marker)).toBe("⡀");
		expect(Bun.stripANSI(quadrants.marker)).toBe("▝");
		expect(Bun.stripANSI(sparkle.marker)).toBe("✧");
		expect(Bun.stripANSI(lineRainbow.text)).toBe("Working");
		expect(lineRainbow.text).not.toBe(colors.fg("text.primary", "Working"));
		expect(staticGlow.text).toBe(pulseGlow.text);
		expect(Bun.stripANSI(staticFrame.marker)).toBe("●");
		expect(Bun.stripANSI(staticFrame.text)).toBe("Working");
		expect(staticFrame.text).not.toBe(staticGlow.text);
	});

	test("uses each configured cadence and stops repainting for static activity", () => {
		expect(configuredAnimationCadenceMs("spinner", "off")).toBe(80);
		expect(configuredAnimationCadenceMs("pulse", "off")).toBe(120);
		expect(configuredAnimationCadenceMs("line", "off")).toBe(100);
		expect(configuredAnimationCadenceMs("arc", "off")).toBe(90);
		expect(configuredAnimationCadenceMs("dots", "off")).toBe(80);
		expect(configuredAnimationCadenceMs("quadrants", "off")).toBe(100);
		expect(configuredAnimationCadenceMs("sparkle", "off")).toBe(240);
		expect(configuredAnimationCadenceMs("dna", "off")).toBe(90);
		expect(configuredAnimationCadenceMs("radar", "off")).toBe(100);
		expect(configuredAnimationCadenceMs("bounce", "off")).toBe(110);
		expect(configuredAnimationCadenceMs("orbit", "off")).toBe(100);
		expect(configuredAnimationCadenceMs("conveyor", "off")).toBe(120);
		expect(configuredAnimationCadenceMs("heartbeat", "off")).toBe(110);
		expect(configuredAnimationCadenceMs("nerd-morph", "off")).toBe(180);
		expect(configuredAnimationCadenceMs("nerd-pipeline", "off")).toBe(160);
		expect(configuredAnimationCadenceMs("nerd-pi-orbit", "off")).toBe(140);
		expect(configuredAnimationCadenceMs("off", "sweep")).toBe(90);
		expect(configuredAnimationCadenceMs("off", "glow")).toBe(70);
		expect(configuredAnimationCadenceMs("off", "rainbow")).toBe(80);
		expect(configuredAnimationCadenceMs("pulse", "glow")).toBe(70);
		expect(configuredAnimationCadenceMs("static", "off")).toBeUndefined();

		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		configureTuiAppearance({ activityMarker: "static", shimmer: "off" });
		const mount = mountConfiguredAnimation({ requestRender: () => renders++ }, { scheduler });
		expect(scheduler.activeTimerCount).toBe(0);

		configureTuiAppearance({ activityMarker: "pulse" });
		expect(clock.timers.at(-1)?.cadenceMs).toBe(120);
		expect(scheduler.activeTimerCount).toBe(1);
		expect(renders).toBe(1);

		configureTuiAppearance({ activityMarker: "static" });
		expect(scheduler.activeTimerCount).toBe(0);
		expect(renders).toBe(2);
		mount.dispose();
	});

	test("keeps every compact marker at its declared width", () => {
		const colors = tuiTheme(theme);
		const styles = [
			["pipe", 1],
			["grow-vertical", 1],
			["grow-horizontal", 1],
			["triangle", 1],
			["circle-quarters", 1],
			["circle-halves", 1],
			["bracket-spin", 1],
			["braille-wave", 4],
			["braille-dna", 4],
			["braille-scan", 4],
			["braille-rain", 4],
			["braille-scanline", 3],
			["braille-pulse", 3],
			["braille-sparkle", 4],
			["braille-cascade", 4],
			["braille-columns", 3],
			["braille-orbit", 1],
			["braille-breathe", 1],
			["braille-wave-rows", 4],
			["braille-checkerboard", 3],
			["braille-helix", 4],
			["scanline", 3],
			["snake", 2],
			["fill-sweep", 2],
			["diagonal-swipe", 2],
			["dna", 3],
			["radar", 3],
			["bounce", 3],
			["orbit", 3],
			["conveyor", 3],
			["heartbeat", 3],
			["nerd-progress", 1],
			["nerd-morph", 1],
			["nerd-pipeline", 3],
			["nerd-pi-orbit", 3],
		] as const;
		configureTuiAppearance({ iconPack: "nerd-fonts" });
		for (const [markerStyle, width] of styles) {
			for (let elapsedMs = 0; elapsedMs < 1_000; elapsedMs += 70) {
				const frame = activityFrame(colors, "Working", elapsedMs, { markerStyle, shimmerStyle: "off" });
				expect(visibleWidth(Bun.stripANSI(frame.marker))).toBe(width);
				expect(Bun.stripANSI(frame.text)).toBe("Working");
			}
		}
	});

	test("keeps Unicode arc separate from the Nerd Font progress spinner", () => {
		const colors = tuiTheme(theme);
		configureTuiAppearance({ iconPack: "unicode" });
		expect(Bun.stripANSI(activityFrame(colors, "Working", 0, { markerStyle: "arc", shimmerStyle: "off" }).marker)).toBe(
			"◜",
		);

		configureTuiAppearance({ iconPack: "nerd-fonts" });
		expect(Bun.stripANSI(activityFrame(colors, "Working", 0, { markerStyle: "arc", shimmerStyle: "off" }).marker)).toBe(
			"◜",
		);
		expect(
			Bun.stripANSI(activityFrame(colors, "Working", 450, { markerStyle: "nerd-progress", shimmerStyle: "off" }).marker),
		).toBe("");
	});

	test("renders the referenced four-cell Braille wave at 100 ms cadence", () => {
		const colors = tuiTheme(theme);
		const expected = ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"];
		for (const [index, frame] of expected.entries()) {
			expect(
				Bun.stripANSI(
					activityFrame(colors, "Working", index * 100, { markerStyle: "braille-wave", shimmerStyle: "off" }).marker,
				),
			).toBe(frame);
		}
	});

	test("falls back from Nerd Font markers only when that icon pack is inactive", () => {
		const colors = tuiTheme(theme);
		configureTuiAppearance({ iconPack: "unicode" });
		const fallback = Bun.stripANSI(
			activityFrame(colors, "Working", 0, { markerStyle: "nerd-pipeline", shimmerStyle: "off" }).marker,
		);
		expect(fallback).toBe("|  ");

		configureTuiAppearance({ iconPack: "nerd-fonts" });
		const nerdFont = Bun.stripANSI(
			activityFrame(colors, "Working", 0, { markerStyle: "nerd-pipeline", shimmerStyle: "off" }).marker,
		);
		expect(nerdFont).toBe("\uf0e7--");
	});

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

	test("rainbow shimmer preserves text while moving through semantic hues", () => {
		const colors = tuiTheme(theme);
		const first = rainbowShimmerFrame(colors, "Working", 0);
		const later = rainbowShimmerFrame(colors, "Working", 320);
		expect(Bun.stripANSI(first)).toBe("Working");
		expect(Bun.stripANSI(later)).toBe("Working");
		expect(later).not.toBe(first);
	});

	test("shimmer keeps grapheme clusters intact", () => {
		const colors = tuiTheme(theme);
		const text = "e\u0301 👩🏽‍💻";
		for (const frame of [shimmerFrame(colors, text, 70), rainbowShimmerFrame(colors, text, 80)]) {
			expect(Bun.stripANSI(frame)).toBe(text);
			expect(frame).not.toContain("e\u001b[0m\u0301");
		}
	});

	test("reduced motion keeps pulse and shimmer at their base tones", () => {
		const colors = tuiTheme(theme);
		expect(pulseGlyphFrame(colors, "●", 600, { reducedMotion: true })).toBe(colors.fg("text.muted", "●"));
		expect(shimmerFrame(colors, "working", 600, { reducedMotion: true })).toBe(colors.fg("text.secondary", "working"));
		expect(rainbowShimmerFrame(colors, "working", 600, { reducedMotion: true })).toBe(
			colors.fg("text.secondary", "working"),
		);
	});
});
