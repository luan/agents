import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme } from "../src/color/theme.ts";
import { ActivityIndicator, ProgressBar, progressFrame } from "../src/decoration/status.ts";

const theme = {
	name: "progress-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;180;180;180m",
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

describe("bounded progress rendering", () => {
	test("rejects control and wide custom glyphs that break the cell contract", () => {
		const frame = progressFrame(tuiTheme(theme), {
			width: 4,
			value: 0.5,
			filled: "界",
			empty: "\n",
		});

		expect(visibleWidth(frame)).toBe(4);
		expect(stripTerminalSequences(frame)).toBe("━━──");
	});

	test("sanitizes activity and progress labels into one component row", () => {
		const activity = new ActivityIndicator({
			theme,
			label: "build\nnext\x1b]52;c;secret\x07",
			detail: "phase\r2",
			spinnerFrames: ["界"],
			requestRender() {},
			reducedMotion: true,
		});
		const progress = new ProgressBar({ theme, value: 0.5, label: "one\ntwo" });

		for (const line of [...activity.render(80), ...progress.render(80)]) {
			expect(stripTerminalSequences(line)).not.toMatch(/[\n\r]/u);
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		activity.dispose();
	});
});
