import { beforeEach, describe, expect, test } from "bun:test";
import {
	getWorkingTimerSnapshot,
	renderPolishedEditorForTest,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingAnimationForTest,
	setWorkingFastMode,
} from "./editor";

const rgbTheme = {
	fg: (color: string, text: string) =>
		`\x1b[${color === "warning" ? "38;2;255;220;40" : "38;2;100;50;200"}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
	getFgAnsi: (color: string) => (color === "warning" ? "\x1b[38;2;255;220;40m" : "\x1b[38;2;100;50;200m"),
} as any;

function editor(overrides: Record<string, unknown> = {}) {
	return {
		transformEditorLine: (line: string) => line,
		...overrides,
	};
}

describe("polished TUI editor", () => {
	beforeEach(() => {
		setWorkingAnimationForTest(false, 0);
		setWorkingFastMode(false);
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
	});

	test("can snapshot active work as completed time for teardown persistence", () => {
		setWorkingAnimationForTest(true, 0, {
			elapsedMs: 32_400,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
		});

		expect(getWorkingTimerSnapshot(1_700_000_001_000, { freezeActive: true })).toMatchObject({
			active: false,
			lastTurnMs: 32_400,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 36_400,
			persistedAtMs: 1_700_000_001_000,
		});
	});

	test("ignores stale session identity providers during render", () => {
		setEditorSessionIdentityProvider(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		expect(() =>
			renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 40, () => ["", "> hello", ""], rgbTheme),
		).not.toThrow();
	});
});
