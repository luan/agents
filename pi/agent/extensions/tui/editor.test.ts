import { beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatWorkingDuration,
	getWorkingTimerSnapshot,
	renderPolishedEditorForTest,
	restoreWorkingTimerSnapshot,
	setEditorChromeProvider,
	setEditorSessionIdentityProvider,
	setWorkingAnimationForTest,
} from "./editor";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "dim" ? 2 : 37}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
} as any;
const rgbTheme = {
	fg: (_color: string, text: string) => `\x1b[38;2;100;50;200m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;50;200m",
} as any;

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

function editor(overrides: Record<string, unknown> = {}) {
	return {
		transformEditorLine: (line: string) => line,
		...overrides,
	};
}

describe("polished TUI editor", () => {
	beforeEach(() => {
		setWorkingAnimationForTest(false, 0);
		setEditorChromeProvider(undefined);
		setEditorSessionIdentityProvider(undefined);
	});

	test("keeps autocomplete lines after the editor frame", () => {
		const lines = renderPolishedEditorForTest(
			editor({
				isShowingAutocomplete: () => true,
				autocompleteList: { render: () => ["$question"] },
			}),
			50,
			() => ["> $q", "", "$question"],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toBe("$question");
	});

	test("renders animated working text on the first editor row", () => {
		setWorkingAnimationForTest(true, 3);

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Working…");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("formats working durations without padding", () => {
		expect(formatWorkingDuration(32_400)).toBe("32s");
		expect(formatWorkingDuration(5 * 60_000 + 20_900)).toBe("5m20s");
		expect(formatWorkingDuration(3 * 3_600_000 + 5 * 60_000 + 20_000)).toBe("3h5m20s");
	});

	test("renders a dim elapsed timer while working", () => {
		setWorkingAnimationForTest(true, 3, {
			elapsedMs: 32_400,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
		});

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 80, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toContain("Working… 32s. Total cumulative: 19h20m36s.");
		expect(lines[0]).toContain("\x1b[2m 32s. Total cumulative: 19h20m36s.\x1b[39m");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders last and cumulative working time after work finishes", () => {
		setWorkingAnimationForTest(false, 0, {
			lastTurnMs: 3 * 3_600_000 + 5 * 60_000 + 20_000,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
		});

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 80, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toContain("Last turn: 3h5m20s. Total cumulative: 19h20m4s.");
		expect(lines[0]).toContain("\x1b[2mLast turn: 3h5m20s. Total cumulative: 19h20m4s.\x1b[39m");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("restores persisted working time after reload or resume", () => {
		setWorkingAnimationForTest(false);
		restoreWorkingTimerSnapshot({
			active: false,
			lastTurnMs: 5 * 60_000 + 20_000,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
			persistedAtMs: 1_700_000_000_000,
		});

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 80, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toContain("Last turn: 5m20s. Total cumulative: 19h20m4s.");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
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

	test("renders session identity before animated working text", () => {
		setWorkingAnimationForTest(true, 3);
		setEditorSessionIdentityProvider(() => ({ name: "Spawn refactor" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			80,
			() => ["> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("Spawn refactor · Working…");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("ignores stale session identity providers during render", () => {
		setEditorSessionIdentityProvider(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).not.toContain("This extension ctx is stale");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("truncates long session identity before working status", () => {
		setWorkingAnimationForTest(true, 3);
		setEditorSessionIdentityProvider(() => ({ name: "A very long named session that should shrink first" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			80,
			() => ["> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines[0] ?? "")).toContain("… · Working…");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders session label and secondary rail color outside normal mode", () => {
		setEditorSessionIdentityProvider(() => ({ label: "A2", name: "Tests", color: "74c7ec" }));

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "insert" }), 32, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toStartWith("▐▌ A2 Tests");
		expect(lines[0]).toContain("\x1b[38;2;116;199;236m▐");
		expect(lines[0]).toContain("\x1b[38;2;72;123;146mA2 Tests");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("uses identity color as the normal-mode rail without an extra identity rail", () => {
		setEditorSessionIdentityProvider(() => ({ label: "A2", name: "Tests", color: "74c7ec" }));

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "normal" }), 32, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toStartWith("┃ A2 Tests");
		expect(stripAnsi(lines[0] ?? "")).not.toStartWith("▐▌");
		expect(lines[0]).toContain("\x1b[38;2;116;199;236m┃");
		expect(lines[0]).toContain("\x1b[38;2;72;123;146mA2 Tests");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("right-aligns editor chrome status on the first row", () => {
		setEditorChromeProvider(() => ({ topRight: "status" }));

		const lines = renderPolishedEditorForTest(editor({ getMode: () => "normal" }), 40, () => ["> hello", ""], theme);

		expect(stripAnsi(lines[0] ?? "")).toEndWith("status");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("does not paint the editor background", () => {
		const background = "\x1b[48;2;237;231;246m";
		const backgroundTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => (color === "customMessageBg" ? `${background}${text}\x1b[49m` : text),
			getBgAnsi: (color: string) => (color === "customMessageBg" ? background : undefined),
		} as any;

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			backgroundTheme,
		);

		expect(lines.join("\n")).not.toContain(background);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("pulses the rail background from the mode color while working", () => {
		setWorkingAnimationForTest(true, 0);
		const dark = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			rgbTheme,
		)[0];

		setWorkingAnimationForTest(true, 13);
		const bright = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["> hello", ""],
			rgbTheme,
		)[0];

		expect(dark).toContain("\x1b[48;2;18;9;36m");
		expect(bright).toContain("\x1b[48;2;121;60;241m");
		expect(dark).not.toBe(bright);
	});
});
