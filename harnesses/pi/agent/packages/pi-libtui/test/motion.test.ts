import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { tuiTheme } from "../src/color/theme.ts";
import type { MotionClock, MotionRenderTarget, MotionTimerHandle } from "../src/motion.ts";
import {
	activityFrame,
	animationSmoothnessCadenceMs,
	animationSpeedMultiplier,
	configuredAnimationCadenceMs,
	glyphFrame,
	lightningShimmerFrame,
	MotionScheduler,
	mountConfiguredAnimation,
	pulseFrame,
	pulseGlyphFrame,
	rainbowGlowShimmerFrame,
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
		const spinner = activityFrame(colors, "Working", 0, { indicatorStyle: "spinner", textEffectStyle: "off" });
		const pulseGlow = activityFrame(colors, "Working", 300, {
			indicatorStyle: "static",
			textEffectStyle: "glow",
			pulseEffectStyle: "color",
		});
		const markerlessSweep = activityFrame(colors, "Working", 140, { indicatorStyle: "off", textEffectStyle: "sweep" });
		const staticGlow = activityFrame(colors, "Working", 300, { indicatorStyle: "static", textEffectStyle: "glow" });
		const lineRainbow = activityFrame(colors, "Working", 140, { indicatorStyle: "line", textEffectStyle: "rainbow" });
		const arc = activityFrame(colors, "Working", 160, { indicatorStyle: "arc", textEffectStyle: "off" });
		const dots = activityFrame(colors, "Working", 240, { indicatorStyle: "dots", textEffectStyle: "off" });
		const quadrants = activityFrame(colors, "Working", 200, { indicatorStyle: "quadrants", textEffectStyle: "off" });
		const sparkle = activityFrame(colors, "Working", 240, { indicatorStyle: "sparkle", textEffectStyle: "off" });
		const staticFrame = activityFrame(colors, "Working", 10_000, { indicatorStyle: "static", textEffectStyle: "off" });

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
		expect(Bun.stripANSI(staticGlow.text)).toBe(Bun.stripANSI(pulseGlow.text));
		expect(staticGlow.text).not.toBe(pulseGlow.text);
		expect(Bun.stripANSI(staticFrame.marker)).toBe("●");
		expect(Bun.stripANSI(staticFrame.text)).toBe("Working");
		expect(staticFrame.text).not.toBe(staticGlow.text);
	});

	test("separates animation speed from repaint smoothness and stops static activity", () => {
		expect(animationSpeedMultiplier("slow")).toBe(0.6);
		expect(animationSpeedMultiplier("relaxed")).toBe(0.8);
		expect(animationSpeedMultiplier("normal")).toBe(1);
		expect(animationSpeedMultiplier("fast")).toBe(1.35);
		expect(animationSpeedMultiplier("very-fast")).toBe(1.7);
		expect(animationSmoothnessCadenceMs("economy")).toBe(80);
		expect(animationSmoothnessCadenceMs("balanced")).toBe(33);
		expect(animationSmoothnessCadenceMs("smooth")).toBe(22);
		expect(animationSmoothnessCadenceMs("ultra")).toBe(16);
		expect(configuredAnimationCadenceMs("spinner", "off")).toBe(80);
		expect(configuredAnimationCadenceMs("off", "lightning", "ultra")).toBe(16);
		expect(configuredAnimationCadenceMs("off", "lightning", "ultra", "very-fast")).toBe(16);
		expect(configuredAnimationCadenceMs("static", "off", "economy", "normal", "pulse")).toBe(80);
		expect(configuredAnimationCadenceMs("static", "off", "economy", "normal", "color")).toBe(80);
		expect(configuredAnimationCadenceMs("static", "off")).toBeUndefined();

		const colors = tuiTheme(theme);
		const slow = activityFrame(colors, "Working", 200, {
			indicatorStyle: "line",
			textEffectStyle: "off",
			animationSpeed: "slow",
		});
		const fast = activityFrame(colors, "Working", 200, {
			indicatorStyle: "line",
			textEffectStyle: "off",
			animationSpeed: "fast",
		});
		expect(Bun.stripANSI(slow.marker)).toBe("\\");
		expect(Bun.stripANSI(fast.marker)).toBe("|");

		const clock = new FakeClock();
		const scheduler = new MotionScheduler(clock);
		let renders = 0;
		configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
		const mount = mountConfiguredAnimation({ requestRender: () => renders++ }, { scheduler });
		expect(scheduler.activeTimerCount).toBe(0);

		configureTuiAppearance({
			activityIndicator: "off",
			textEffect: "lightning",
			animationSpeed: "very-fast",
			animationSmoothness: "ultra",
		});
		expect(clock.timers.at(-1)?.cadenceMs).toBe(16);
		expect(scheduler.activeTimerCount).toBe(1);
		expect(renders).toBe(1);

		configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
		expect(scheduler.activeTimerCount).toBe(0);
		expect(renders).toBe(2);
		mount.dispose();

		configureTuiAppearance({ activityIndicator: "spinner", textEffect: "off" });
		const markerless = mountConfiguredAnimation(
			{ requestRender: () => renders++ },
			{ scheduler, indicatorStyle: "off" },
		);
		expect(scheduler.activeTimerCount).toBe(0);
		configureTuiAppearance({ activityIndicator: "off", textEffect: "off" });
		const explicitSpinner = mountConfiguredAnimation(
			{ requestRender: () => renders++ },
			{ scheduler, indicatorStyle: "spinner" },
		);
		expect(scheduler.activeTimerCount).toBe(1);
		markerless.dispose();
		explicitSpinner.dispose();
	});

	test("samples marker and shimmer from one elapsed timeline without changing either pace", () => {
		const colors = tuiTheme(theme);
		const markerOnly = activityFrame(colors, "Working", 140, {
			indicatorStyle: "spinner",
			textEffectStyle: "off",
		});
		const combined = activityFrame(colors, "Working", 140, {
			indicatorStyle: "spinner",
			textEffectStyle: "glow",
		});
		const nextCombined = activityFrame(colors, "Working", 280, {
			indicatorStyle: "spinner",
			textEffectStyle: "glow",
		});

		expect(Bun.stripANSI(markerOnly.marker)).toBe("⠙");
		expect(Bun.stripANSI(combined.marker)).toBe("⠙");
		expect(Bun.stripANSI(nextCombined.marker)).toBe("⠸");
		expect(nextCombined.text).not.toBe(combined.text);
	});

	test("samples lightning artifacts on every configured repaint without speeding its strike", () => {
		const colors = tuiTheme(theme);
		for (const animationSpeed of ["slow", "normal", "very-fast"] as const) {
			const frames = Array.from({ length: 12 }, (_, index) => {
				const frame = activityFrame(colors, "Working...", index * 33, {
					indicatorStyle: "static",
					textEffectStyle: "lightning",
					textEffectScope: "inline",
					animationSpeed,
					animationSmoothness: "balanced",
				});
				return `${frame.marker}${frame.text}`;
			});
			expect(new Set(frames).size).toBe(frames.length);
		}
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
		for (const [indicatorStyle, width] of styles) {
			for (let elapsedMs = 0; elapsedMs < 1_000; elapsedMs += 70) {
				const frame = activityFrame(colors, "Working", elapsedMs, { indicatorStyle, textEffectStyle: "off" });
				expect(visibleWidth(Bun.stripANSI(frame.marker))).toBe(width);
				expect(Bun.stripANSI(frame.text)).toBe("Working");
			}
		}
	});

	test("keeps Unicode arc separate from the Nerd Font progress spinner", () => {
		const colors = tuiTheme(theme);
		configureTuiAppearance({ iconPack: "unicode" });
		expect(
			Bun.stripANSI(activityFrame(colors, "Working", 0, { indicatorStyle: "arc", textEffectStyle: "off" }).marker),
		).toBe("◜");

		configureTuiAppearance({ iconPack: "nerd-fonts" });
		expect(
			Bun.stripANSI(activityFrame(colors, "Working", 0, { indicatorStyle: "arc", textEffectStyle: "off" }).marker),
		).toBe("◜");
		expect(
			Bun.stripANSI(
				activityFrame(colors, "Working", 450, { indicatorStyle: "nerd-progress", textEffectStyle: "off" }).marker,
			),
		).toBe("");
	});

	test("renders the referenced four-cell Braille wave at 100 ms cadence", () => {
		const colors = tuiTheme(theme);
		const expected = ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"];
		for (const [index, frame] of expected.entries()) {
			expect(
				Bun.stripANSI(
					activityFrame(colors, "Working", index * 100, { indicatorStyle: "braille-wave", textEffectStyle: "off" })
						.marker,
				),
			).toBe(frame);
		}
	});

	test("falls back from Nerd Font markers only when that icon pack is inactive", () => {
		const colors = tuiTheme(theme);
		configureTuiAppearance({ iconPack: "unicode" });
		const fallback = Bun.stripANSI(
			activityFrame(colors, "Working", 0, { indicatorStyle: "nerd-pipeline", textEffectStyle: "off" }).marker,
		);
		expect(fallback).toBe("|  ");

		configureTuiAppearance({ iconPack: "nerd-fonts" });
		const nerdFont = Bun.stripANSI(
			activityFrame(colors, "Working", 0, { indicatorStyle: "nerd-pipeline", textEffectStyle: "off" }).marker,
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

	test("color pulse composes over a stable indicator and text", () => {
		const colors = tuiTheme(theme);
		const frames = Array.from({ length: 37 }, (_, index) => pulseGlyphFrame(colors, "●", index * 33));
		const foregrounds = new Set(frames.flatMap((frame) => frame.match(/\x1b\[38;[^m]+m/gu) ?? []));

		expect(foregrounds.size).toBeGreaterThan(20);
		const samples = [0, 150, 300, 450, 600].map((elapsedMs) =>
			activityFrame(colors, "Working", elapsedMs, {
				indicatorStyle: "static",
				textEffectStyle: "glow",
				pulseEffectStyle: "color",
			}),
		);
		const markers = samples.map((sample) => sample.marker);
		expect(markers.map(Bun.stripANSI)).toEqual(["●", "●", "●", "●", "●"]);
		expect(new Set(markers).size).toBeGreaterThan(2);
		expect(new Set(samples.map((sample) => sample.text)).size).toBeGreaterThan(2);
	});

	test("pulse fades the composed indicator and text from dim to bright without changing glyphs", () => {
		const colors = tuiTheme(theme);
		const dim = activityFrame(colors, "Working", 0, {
			indicatorStyle: "static",
			textEffectStyle: "off",
			pulseEffectStyle: "pulse",
		});
		const bright = activityFrame(colors, "Working", 600, {
			indicatorStyle: "static",
			textEffectStyle: "off",
			pulseEffectStyle: "pulse",
		});

		expect(Bun.stripANSI(dim.marker)).toBe("●");
		expect(Bun.stripANSI(bright.marker)).toBe("●");
		expect(Bun.stripANSI(dim.text)).toBe("Working");
		expect(Bun.stripANSI(bright.text)).toBe("Working");
		expect(dim.marker).not.toBe(bright.marker);
		expect(dim.text).not.toBe(bright.text);
		expect(dim.marker).toContain(colors.fgAnsi(colors.adjustForegroundBrightness("accent", -0.4)));
		expect(bright.marker).toContain(colors.fgAnsi(colors.adjustForegroundBrightness("accent", 0.18)));
	});

	test("shimmer reaches the final cell with a continuous cosine glow", () => {
		const colors = tuiTheme(theme);
		const text = "working status";
		const final = shimmerFrame(colors, text, ((text.length - 1 + 10) / 30) * 1_000);
		const glow = shimmerFrame(colors, text, ((6 + 10) / 30) * 1_000);

		expect(final).toContain(colors.fg("accent", "s"));
		expect(new Set(glow.match(/\x1b\[38;[^m]+m/gu) ?? []).size).toBeGreaterThan(5);
		expect(shimmerFrame(colors, text, 10)).toBe(colors.fg("text.secondary", text));
	});

	test("glow chooses a visible contrast when its base text already uses the accent", () => {
		const colors = tuiTheme(theme);
		const glow = shimmerFrame(colors, "accent text", (10 / 30) * 1_000, { baseTone: "accent" });

		expect(Bun.stripANSI(glow)).toBe("accent text");
		expect(glow).not.toBe(colors.fg("accent", "accent text"));
		expect(new Set(glow.match(/\x1b\[38;[^m]+m/gu) ?? []).size).toBeGreaterThan(3);
	});

	test("shimmers marker and text through one shared color ramp", () => {
		const colors = tuiTheme(theme);
		const atMarker = activityFrame(colors, "Working", (10 / 30) * 1_000, {
			indicatorStyle: "static",
			textEffectStyle: "glow",
			textEffectScope: "inline",
		});
		const atText = activityFrame(colors, "Working", (12 / 30) * 1_000, {
			indicatorStyle: "static",
			textEffectStyle: "glow",
			textEffectScope: "inline",
		});

		expect(atMarker.marker).toContain(colors.fgAnsi("accent"));
		expect(atText.text).toContain(colors.fg("accent", "W"));
		expect(atMarker.text).toContain(colors.fgAnsi("text.muted"));
	});

	test("rainbow shimmer preserves text while moving through semantic hues", () => {
		const colors = tuiTheme(theme);
		const first = rainbowShimmerFrame(colors, "Working", 0);
		const later = rainbowShimmerFrame(colors, "Working", 320);
		expect(Bun.stripANSI(first)).toBe("Working");
		expect(Bun.stripANSI(later)).toBe("Working");
		expect(later).not.toBe(first);
	});

	test("rainbow glow preserves text while moving a broad color highlight", () => {
		const colors = tuiTheme(theme);
		const first = rainbowGlowShimmerFrame(colors, "Working", 0);
		const later = rainbowGlowShimmerFrame(colors, "Working", 320);
		expect(Bun.stripANSI(first)).toBe("Working");
		expect(Bun.stripANSI(later)).toBe("Working");
		expect(later).not.toBe(first);
	});

	test("lightning ports the fast-mode reverse strike and ASCII variants", () => {
		const colors = tuiTheme(theme);
		const first = lightningShimmerFrame(colors, "Working", 0);
		const later = lightningShimmerFrame(colors, "Working", 120);
		expect(Bun.stripANSI(first).normalize("NFD")).toBe("W\u0307o\u0307r\u0307k\u0307in\u0307g\u0307".normalize("NFD"));
		expect(visibleWidth(Bun.stripANSI(first))).toBe(visibleWidth("Working"));
		expect(Bun.stripANSI(later)).not.toBe(Bun.stripANSI(first));
		expect(first).toContain("\x1b[1;9m");
		expect(first).toContain("\x1b[9m");
	});

	test("lightning gives every printable ASCII character nine fixed-width variants", () => {
		const colors = tuiTheme(theme);
		for (let codePoint = 0x20; codePoint <= 0x7e; codePoint++) {
			const character = String.fromCharCode(codePoint);
			const variants = Array.from({ length: 9 }, (_, frame) =>
				Bun.stripANSI(lightningShimmerFrame(colors, character, frame * 60)),
			);
			expect(new Set(variants).size).toBe(9);
			for (const variant of variants) expect(visibleWidth(variant)).toBe(1);
		}
	});

	test("marker shimmer crosses marker, separator, and text as one unit", () => {
		const colors = tuiTheme(theme);
		const plain = activityFrame(colors, "AB", 0, {
			indicatorStyle: "line",
			textEffectStyle: "lightning",
			textEffectScope: "message",
		});
		const textStrike = activityFrame(colors, "AB", 0, {
			indicatorStyle: "line",
			textEffectStyle: "lightning",
			textEffectScope: "inline",
		});
		const markerStrike = activityFrame(colors, "AB", 360, {
			indicatorStyle: "line",
			textEffectStyle: "lightning",
			textEffectScope: "inline",
		});
		expect(Bun.stripANSI(textStrike.marker).normalize("NFD").replace(/\p{M}/gu, "")).toBe(Bun.stripANSI(plain.marker));
		expect(visibleWidth(Bun.stripANSI(textStrike.marker))).toBe(1);
		expect(Bun.stripANSI(textStrike.marker)).not.toBe(Bun.stripANSI(plain.marker));
		expect(textStrike.marker).not.toContain("\x1b[1;9m");
		expect(textStrike.text).toContain("\x1b[1;9m");
		expect(markerStrike.marker).toContain("\x1b[1;9m");
	});

	test("shimmer keeps grapheme clusters intact", () => {
		const colors = tuiTheme(theme);
		const text = "e\u0301 👩🏽‍💻";
		for (const frame of [
			shimmerFrame(colors, text, 70),
			rainbowShimmerFrame(colors, text, 80),
			rainbowGlowShimmerFrame(colors, text, 80),
			lightningShimmerFrame(colors, text, 60, { variantAscii: false }),
		]) {
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
		expect(rainbowGlowShimmerFrame(colors, "working", 600, { reducedMotion: true })).toBe(
			colors.fg("text.secondary", "working"),
		);
		expect(lightningShimmerFrame(colors, "working", 600, { reducedMotion: true })).toBe(
			colors.fg("text.secondary", "working"),
		);
	});
});
