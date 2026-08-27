import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import type { MotionClock, MotionTimerHandle } from "../src/motion.ts";
import { MotionScheduler } from "../src/motion.ts";
import { RequestAnimationController } from "../src/request-animation.ts";

const theme = {
	name: "request-animation-test",
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "accent" ? "\x1b[38;2;80;160;240m" : "\x1b[38;2;180;180;180m"),
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

interface FakeTimer extends MotionTimerHandle {
	callback: () => void;
	cadenceMs: number;
	stopped: boolean;
}

class FakeClock implements MotionClock {
	currentMs = 0;
	readonly timers: FakeTimer[] = [];

	now(): number {
		return this.currentMs;
	}

	start(callback: () => void, cadenceMs: number): FakeTimer {
		const timer = { callback, cadenceMs, stopped: false };
		this.timers.push(timer);
		return timer;
	}

	stop(handle: MotionTimerHandle): void {
		(handle as FakeTimer).stopped = true;
	}
}

class FakeUi {
	readonly theme = theme;
	readonly indicators: Array<{ frames?: string[] } | undefined> = [];
	readonly messages: Array<string | undefined> = [];

	setWorkingIndicator(indicator?: { frames?: string[] }): void {
		this.indicators.push(indicator);
	}

	setWorkingMessage(message?: string): void {
		this.messages.push(message);
	}

	get text(): string {
		return Bun.stripANSI(this.messages.at(-1) ?? "");
	}
}

afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

describe("request animation", () => {
	test("tracks thinking, parallel tools, and working with the documented priority", () => {
		const clock = new FakeClock();
		const ui = new FakeUi();
		const controller = new RequestAnimationController({
			now: () => clock.now(),
			scheduler: new MotionScheduler(clock),
		});

		controller.start({ ui });
		expect(ui.indicators.at(-1)).toEqual({ frames: [] });
		expect(ui.text).toContain("Working...");

		controller.startTool("first");
		controller.startTool("second");
		expect(ui.text).toContain("Running...");

		controller.setThinking(true);
		expect(ui.text).toContain("Thinking...");
		controller.finishTool("first");
		expect(ui.text).toContain("Thinking...");

		controller.setThinking(false);
		expect(ui.text).toContain("Running...");
		controller.finishTool("second");
		expect(ui.text).toContain("Working...");

		controller.finish({ ui });
		expect(ui.messages.at(-1)).toBeUndefined();
		expect(ui.indicators.at(-1)).toBeUndefined();
		controller.dispose();
	});

	test("applies phase indicator and text-effect overrides without changing the defaults", () => {
		configureTuiAppearance({
			activityIndicator: "spinner",
			textEffect: "off",
			thinkingIndicator: "off",
			thinkingTextEffect: "off",
			toolIndicator: "static",
		});
		const clock = new FakeClock();
		const ui = new FakeUi();
		const controller = new RequestAnimationController({
			now: () => clock.now(),
			scheduler: new MotionScheduler(clock),
		});

		controller.start({ ui });
		expect(ui.text).toBe("⠋ Working...");
		controller.setThinking(true);
		expect(ui.text).toBe("Thinking...");
		controller.setThinking(false);
		controller.startTool("tool");
		expect(ui.text).toBe("● Running...");

		controller.dispose({ ui });
	});

	test("uses exclusive status scenes intentionally and resolves phase overrides", () => {
		configureTuiAppearance({
			statusPresentation: "block-wave",
			thinkingPresentation: "pacman",
			toolPresentation: "standard",
		});
		const clock = new FakeClock();
		const ui = new FakeUi();
		const controller = new RequestAnimationController({
			now: () => clock.now(),
			scheduler: new MotionScheduler(clock),
			width: () => 24,
		});

		controller.start({ ui });
		expect(ui.text).toMatch(/[█▓▒]/u);
		expect(ui.text).not.toContain("Working...");

		controller.setThinking(true);
		expect(ui.text).toMatch(/[ᗧC]/u);
		expect(ui.text).not.toContain("Thinking...");

		controller.setThinking(false);
		controller.startTool("tool");
		expect(ui.text).toContain("Running...");

		controller.dispose({ ui });
	});

	test("composes text effects and message sources with the configured indicator", () => {
		configureTuiAppearance({ activityIndicator: "static", textEffect: "aurora" });
		const clock = new FakeClock();
		const ui = new FakeUi();
		const controller = new RequestAnimationController({
			now: () => clock.now(),
			scheduler: new MotionScheduler(clock),
		});

		controller.start({ ui });
		expect(ui.text).toBe("● Working...");
		clock.currentMs = 350;
		clock.timers.at(-1)?.callback();
		expect(new Set((ui.messages.at(-1) ?? "").match(/\x1b\[38;[^m]+m/gu) ?? []).size).toBeGreaterThan(1);

		configureTuiAppearance({ textEffect: "off", activityMessage: "typewriter" });
		expect(ui.text).toStartWith("● ");
		expect(ui.text).not.toContain("Working...");

		controller.dispose({ ui });
	});
});
