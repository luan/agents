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
	setWorkingFastMode,
} from "./editor";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "dim" ? 2 : 37}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
} as any;
const rgbTheme = {
	fg: (color: string, text: string) =>
		`\x1b[${color === "warning" ? "38;2;255;220;40" : "38;2;100;50;200"}m${text}\x1b[39m`,
	bg: (_color: string, text: string) => text,
	getFgAnsi: (color: string) => (color === "warning" ? "\x1b[38;2;255;220;40m" : "\x1b[38;2;100;50;200m"),
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
		setWorkingFastMode(false);
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

	test("renders animated working text on the bottom editor row", () => {
		setWorkingAnimationForTest(true, 3);

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["", "> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("Working");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("renders zipping with brightness motion for fast requests", () => {
		setWorkingFastMode(true);
		setWorkingAnimationForTest(true, 0);

		const first = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			50,
			() => ["", "> hello", ""],
			rgbTheme,
		);
		setWorkingAnimationForTest(true, 1);
		const second = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			50,
			() => ["", "> hello", ""],
			rgbTheme,
		);
		setWorkingAnimationForTest(true, 9);
		const third = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			50,
			() => ["", "> hello", ""],
			rgbTheme,
		);
		setWorkingAnimationForTest(true, 32);
		const late = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			50,
			() => ["", "> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(first.at(-1) ?? "")).toContain("⚡żippiṅġ…");
		expect(stripAnsi(second.at(-1) ?? "")).toContain("⚡žǐppiňǧ…");
		expect(first.at(-1)).toContain("\x1b[1;9m\x1b[38;2;255;255;50m…\x1b[22;29;39m");
		expect(first.at(-1)).toContain("\x1b[9m\x1b[38;2;166;143;26mż\x1b[29;39m");
		expect(first.at(-1)).toContain("\x1b[9m\x1b[38;2;166;143;26mġ\x1b[29;39m");
		expect(third.at(-1)).toContain("\x1b[1;9m\x1b[38;2;255;255;50mp\x1b[22;29;39m");
		expect(late.at(-1)).toContain("\x1b[1;9m\x1b[38;2;255;255;50m…\x1b[22;29;39m");
		expect(first.at(-1)).not.toBe(second.at(-1));
		expect(first.every((line) => visibleWidth(line) <= 50)).toBe(true);
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

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			80,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("Working… 32s. Total cumulative: 19h20m36s.");
		expect(lines.at(-1)).toContain("\x1b[2m 32s. Total cumulative: 19h20m36s.\x1b[39m");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders last and cumulative working time after work finishes", () => {
		setWorkingAnimationForTest(false, 0, {
			lastTurnMs: 3 * 3_600_000 + 5 * 60_000 + 20_000,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
		});

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			100,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("Last turn: 3h5m20s. Total cumulative: 19h20m4s.");
		expect(lines.at(-1)).toContain("\x1b[2mLast turn: 3h5m20s. Total cumulative: 19h20m4s.\x1b[39m");
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	test("restores persisted working time after reload or resume", () => {
		setWorkingAnimationForTest(false);
		restoreWorkingTimerSnapshot({
			active: false,
			lastTurnMs: 5 * 60_000 + 20_000,
			cumulativeMs: 19 * 3_600_000 + 20 * 60_000 + 4_000,
			persistedAtMs: 1_700_000_000_000,
		});

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			80,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("Last turn: 5m20s. Total cumulative: 19h20m4s.");
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
			100,
			() => ["", "> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("Spawn refactor · Working… 0s. Total cumulative: 0s.");
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	test("ignores stale session identity providers during render", () => {
		setEditorSessionIdentityProvider(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["", "> hello", ""],
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
			() => ["", "> hello", ""],
			rgbTheme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toContain("… · Working… 0s. Total cumulative: 0s.");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders session label and secondary rail color outside normal mode", () => {
		setEditorSessionIdentityProvider(() => ({ label: "A2", name: "Tests", color: "74c7ec" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			32,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toStartWith("▐▌ A2 Tests");
		expect(lines.at(-1)).toContain("\x1b[38;2;116;199;236m▐");
		expect(lines.at(-1)).toContain("\x1b[38;2;72;123;146mA2 Tests");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("uses identity color as the normal-mode rail without an extra identity rail", () => {
		setEditorSessionIdentityProvider(() => ({ label: "A2", name: "Tests", color: "74c7ec" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "normal" }),
			32,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines.at(-1) ?? "")).toStartWith("┃ A2 Tests");
		expect(stripAnsi(lines.at(-1) ?? "")).not.toStartWith("▐▌");
		expect(lines.at(-1)).toContain("\x1b[38;2;116;199;236m┃");
		expect(lines.at(-1)).toContain("\x1b[38;2;72;123;146mA2 Tests");
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("right-aligns editor chrome status on the first row", () => {
		setEditorChromeProvider(() => ({ topRight: "status" }));

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "normal" }),
			40,
			() => ["", "> hello", ""],
			theme,
		);

		expect(stripAnsi(lines[1] ?? "")).toEndWith("status");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("preserves the complete right status before truncating a long prompt", () => {
		setEditorChromeProvider(() => ({ topRight: "project > branch > runtime > model > low" }));
		let editorWidth = 0;

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "normal" }),
			60,
			(width) => {
				editorWidth = width;
				return ["", "> this prompt is much too long to fit beside the complete status", ""];
			},
			theme,
		);

		expect(stripAnsi(lines[1] ?? "")).toEndWith("project > branch > runtime > model > low");
		expect(editorWidth).toBe(17);
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
	});

	test("paints dark-theme editor rows with a compositor background", () => {
		const background = "\x1b[48;2;45;40;56m";
		const darkTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => (color === "customMessageBg" ? `${background}${text}\x1b[49m` : text),
			getBgAnsi: (color: string) => (color === "customMessageBg" ? background : undefined),
		} as any;

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["", "> hello", ""],
			darkTheme,
		);

		expect(lines[1]).toContain("\x1b[48;2;35;31;44m");
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});

	test("preserves the terminal background for light-theme editor rows", () => {
		const background = "\x1b[48;2;237;231;246m";
		const backgroundTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => (color === "customMessageBg" ? `${background}${text}\x1b[49m` : text),
			getBgAnsi: (color: string) => (color === "customMessageBg" ? background : undefined),
		} as any;

		const lines = renderPolishedEditorForTest(
			editor({ getMode: () => "insert" }),
			40,
			() => ["", "> hello", ""],
			backgroundTheme,
		);

		expect(lines.map(stripAnsi)).toEqual([`╻${" ".repeat(39)}`, `┃ > hello${" ".repeat(31)}`, `┃ ${" ".repeat(38)}`]);
	});
});
