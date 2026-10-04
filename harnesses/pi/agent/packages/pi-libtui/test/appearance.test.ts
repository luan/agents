import { afterEach, describe, expect, test } from "bun:test";
import {
	configureAutomaticIconPack,
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	getTuiAppearance,
	isTuiActivityIndicatorStyle,
	requestPhaseAnimation,
	resolveActivityPresentation,
	subscribeTuiAppearance,
	TUI_ACTIVITY_INDICATOR_OPTIONS,
	terminalIconPack,
} from "../src/appearance.ts";
import { icon } from "../src/decoration/glyphs.ts";

describe("shared TUI appearance", () => {
	afterEach(() => {
		configureAutomaticIconPack("unicode");
		configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	});

	test.each(["ghostty", "kitty", "WezTerm"])("auto icons use %s's bundled Nerd glyphs", (terminal) => {
		configureTuiAppearance({ iconPack: "auto" });
		configureAutomaticIconPack(terminalIconPack(terminal));
		expect(getTuiAppearance().iconPack).toBe("nerd-fonts");
		expect(icon("comment")).toBe("");
	});

	test.each([undefined, "", "Apple_Terminal", "iTerm.app", "bootty", "unknown"])(
		"auto icons fall back to Unicode when coverage is unknown (%s)",
		(terminal) => {
			configureTuiAppearance({ iconPack: "auto" });
			configureAutomaticIconPack(terminalIconPack(terminal));
			expect(getTuiAppearance().iconPack).toBe("unicode");
			expect(icon("comment")).toBe("✎");
		},
	);

	test("terminal detection preserves manual choices and Auto responds to capability changes", () => {
		configureTuiAppearance({ iconPack: "emoji" });
		configureAutomaticIconPack("nerd-fonts");
		expect(getTuiAppearance().iconPack).toBe("emoji");
		configureTuiAppearance({ iconPack: "auto" });
		expect(getTuiAppearance().iconPack).toBe("nerd-fonts");
		configureAutomaticIconPack("unicode");
		expect(getTuiAppearance().iconPack).toBe("unicode");
		configureTuiAppearance({ iconPack: "nerd-fonts" });
		configureAutomaticIconPack("unicode");
		expect(getTuiAppearance().iconPack).toBe("nerd-fonts");
	});

	test("starts with portable defaults", () => {
		expect(DEFAULT_TUI_APPEARANCE).toEqual({
			iconPack: "auto",
			activityIndicator: "braille-wave",
			activityMessage: "phase",
			textEffect: "sweep",
			textEffectScope: "message",
			pulseEffect: "off",
			statusPresentation: "standard",
			animationSpeed: "relaxed",
			animationSmoothness: "balanced",
			thinkingIndicator: "braille-pulse",
			thinkingMessage: "inherit",
			thinkingTextEffect: "glow",
			thinkingPulseEffect: "pulse",
			thinkingPresentation: "inherit",
			workingIndicator: "braille-scanline",
			workingMessage: "inherit",
			workingTextEffect: "rainbow-glow",
			workingPulseEffect: "color",
			workingPresentation: "inherit",
			toolIndicator: "inherit",
			toolMessage: "inherit",
			toolTextEffect: "inherit",
			toolPulseEffect: "inherit",
			toolPresentation: "inherit",
			powerline: false,
			powerlineButtons: false,
			softCursor: false,
			userMessageBubbles: true,
			insertionCursor: "virtual",
			navigationCursor: "virtual",
			selectionCursor: "virtual",
		});
		expect(getTuiAppearance()).toEqual({ ...DEFAULT_TUI_APPEARANCE, iconPack: "unicode" });
	});

	test("notifies subscribers only for effective changes", () => {
		let changes = 0;
		const remove = subscribeTuiAppearance(() => {
			changes += 1;
		});

		configureTuiAppearance({ iconPack: "emoji" });
		configureTuiAppearance({ iconPack: "emoji" });
		expect(changes).toBe(1);

		remove();
		configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
		expect(changes).toBe(1);
	});

	test("isolates subscriber failures", () => {
		let changes = 0;
		const removeBroken = subscribeTuiAppearance(() => {
			throw new Error("broken renderer");
		});
		const removeWorking = subscribeTuiAppearance(() => {
			changes += 1;
		});

		configureTuiAppearance({ powerline: true });
		expect(changes).toBe(1);
		removeBroken();
		removeWorking();
	});

	test("resolves inline composition, mixed composition, and exclusive scenes", () => {
		expect(resolveActivityPresentation("spinner", "typewriter", "aurora", "inline", "color", "standard")).toEqual({
			kind: "inline",
			indicatorStyle: "spinner",
			messageStyle: "typewriter",
			textEffectStyle: "aurora",
			textEffectScope: "inline",
			pulseEffectStyle: "color",
		});
		expect(resolveActivityPresentation("spinner", "phase", "off", "message", "color", "brainstorm")).toEqual({
			kind: "composition",
			style: "brainstorm",
		});
		expect(resolveActivityPresentation("spinner", "phase", "off", "message", "color", "starfield")).toEqual({
			kind: "scene",
			style: "starfield",
		});

		configureTuiAppearance({
			activityMessage: "typewriter",
			textEffect: "glow",
			textEffectScope: "inline",
			thinkingIndicator: "off",
			thinkingMessage: "phase",
			thinkingPulseEffect: "color",
		});
		expect(requestPhaseAnimation("thinking")).toEqual({
			kind: "inline",
			indicatorStyle: "off",
			messageStyle: "phase",
			textEffectStyle: "glow",
			textEffectScope: "inline",
			pulseEffectStyle: "color",
		});
	});

	test("ignores invalid values at the shared-state boundary", () => {
		configureTuiAppearance({
			iconPack: "emoji",
			activityIndicator: "static",
			pulseEffect: "color",
			statusPresentation: "block-wave",
			textEffect: "glow",
			textEffectScope: "inline",
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			thinkingIndicator: "off",
			thinkingPresentation: "pacman",
			toolTextEffect: "rainbow",
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "steady-bar",
		});
		configureTuiAppearance({
			iconPack: "invalid" as never,
			activityIndicator: "marquee" as never,
			statusPresentation: "marquee" as never,
			textEffect: "flash" as never,
			textEffectScope: "yes" as never,
			animationSpeed: "warp" as never,
			animationSmoothness: "maximum" as never,
			thinkingIndicator: "marquee" as never,
			thinkingPresentation: "marquee" as never,
			toolTextEffect: "flash" as never,
			powerline: "yes" as never,
			powerlineButtons: "yes" as never,
			softCursor: "yes" as never,
			insertionCursor: "beam" as never,
			navigationCursor: "box" as never,
			selectionCursor: "line" as never,
		});

		expect(getTuiAppearance()).toEqual({
			...DEFAULT_TUI_APPEARANCE,
			iconPack: "emoji",
			activityIndicator: "static",
			pulseEffect: "color",
			statusPresentation: "block-wave",
			textEffect: "glow",
			textEffectScope: "inline",
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			thinkingIndicator: "off",
			thinkingPresentation: "pacman",
			toolTextEffect: "rainbow",
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "steady-bar",
		});
	});

	test("accepts the dim-to-bright pulse independently from color pulse", () => {
		configureTuiAppearance({ pulseEffect: "pulse", toolPulseEffect: "pulse" });

		expect(getTuiAppearance().pulseEffect).toBe("pulse");
		expect(requestPhaseAnimation("tool")).toMatchObject({ pulseEffectStyle: "pulse" });
	});

	test("accepts every published activity indicator at the shared boundary", () => {
		expect(TUI_ACTIVITY_INDICATOR_OPTIONS.every((option) => isTuiActivityIndicatorStyle(option.value))).toBe(true);
	});
});
