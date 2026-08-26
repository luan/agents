import { afterEach, describe, expect, test } from "bun:test";
import {
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	getTuiAppearance,
	subscribeTuiAppearance,
} from "../src/appearance.ts";

describe("shared TUI appearance", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("starts with portable defaults", () => {
		expect(DEFAULT_TUI_APPEARANCE).toEqual({
			iconPack: "unicode",
			activityMarker: "spinner",
			shimmer: "off",
			shimmerMarker: false,
			animationSpeed: "normal",
			animationSmoothness: "balanced",
			powerline: false,
			powerlineButtons: false,
			softCursor: false,
			insertionCursor: "virtual",
			navigationCursor: "virtual",
			selectionCursor: "virtual",
		});
		expect(getTuiAppearance()).toEqual(DEFAULT_TUI_APPEARANCE);
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

	test("ignores invalid values at the shared-state boundary", () => {
		configureTuiAppearance({
			iconPack: "emoji",
			activityMarker: "pulse",
			shimmer: "glow",
			shimmerMarker: true,
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "steady-bar",
		});
		configureTuiAppearance({
			iconPack: "invalid" as never,
			activityMarker: "marquee" as never,
			shimmer: "flash" as never,
			shimmerMarker: "yes" as never,
			animationSpeed: "warp" as never,
			animationSmoothness: "maximum" as never,
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
			activityMarker: "pulse",
			shimmer: "glow",
			shimmerMarker: true,
			animationSpeed: "fast",
			animationSmoothness: "smooth",
			powerlineButtons: true,
			softCursor: true,
			insertionCursor: "steady-bar",
		});
	});
});
