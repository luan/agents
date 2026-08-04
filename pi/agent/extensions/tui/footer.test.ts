import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig, type PolishedTuiConfig } from "./config";
import { emptyFooterState, type FooterRenderState, renderEditorTopStatus, renderFooter } from "./footer";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const COLOR_CODES: Record<string, number> = {
	accent: 35,
	borderAccent: 96,
	dim: 2,
	error: 31,
	success: 32,
	thinkingXhigh: 95,
	warning: 33,
};

const theme = {
	fg: (color: string, text: string) => `\x1b[${COLOR_CODES[color] ?? 37}m${text}\x1b[39m`,
} as any;

const config: PolishedTuiConfig = {
	...defaultConfig,
	icons: {
		...defaultConfig.icons,
		cwd: "",
	},
};

function state(overrides: Partial<FooterRenderState> = {}): FooterRenderState {
	return {
		...emptyFooterState(),
		modelLabel: "m",
		providerLabel: "OpenAI",
		contextPercent: 33,
		contextUsed: 33_000,
		contextTotal: 100_000,
		contextSegments: {
			system: 3000,
			prompt: 10_000,
			assistant: 15_000,
			thinking: 1000,
			tools: 4000,
		},
		...overrides,
	};
}

function stripAnsi(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

describe("renderFooter", () => {
	test("expands the context gauge into slack before right-side metrics", () => {
		const lines = renderFooter(
			state({
				hasTokens: true,
				tokenLabel: "↑100 ↓50",
				hasCost: true,
				costLabel: "$0.01",
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("↑100 ↓50 $0.01")) ?? "";
		const plain = stripAnsi(ctxLine);

		expect(visibleWidth(ctxLine)).toBe(80);
		expect(plain).toContain("ctx ");
		expect(plain).toContain("━");
		expect(plain).toContain("─");
		expect(plain).toContain("33.0%");
		expect(plain).not.toContain("█");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("moves the compact context gauge to its own row when the existing row is crowded", () => {
		const lines = renderFooter(
			state({
				modelLabel: "very-long-model-label",
			}),
			config,
			"/tmp/a/very/long/project/path",
			theme,
			30,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).startsWith("ctx ")) ?? "";
		const plain = stripAnsi(ctxLine);

		expect(visibleWidth(ctxLine)).toBeLessThanOrEqual(30);
		expect(plain).toContain("━");
		expect(plain).toContain("─");
		expect(plain).not.toContain("very-long-model-label");
		expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
	});

	test("renders context as one aggregate used-versus-free bar", () => {
		const lines = renderFooter(
			state({
				contextPercent: 29.6,
				contextUsed: 81_000,
				contextTotal: 272_000,
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);

		const ctxLine = lines.find((line) => stripAnsi(line).includes("29.6% 81k/272k")) ?? "";
		const plain = stripAnsi(ctxLine);
		const usedColumns = [...plain].filter((char) => char === "━").length;
		const freeColumns = [...plain].filter((char) => char === "─").length;

		expect(plain).not.toContain("[s p a r x]");
		expect(usedColumns + freeColumns).toBe(16);
		expect(usedColumns).toBe(5);
	});

	test("colors the context usage suffix by context health", () => {
		const lines = renderFooter(
			state({
				contextPercent: 70.6,
				contextUsed: 192_000,
				contextTotal: 272_000,
			}),
			config,
			"/tmp/p",
			theme,
			80,
		);
		const ctxLine = lines.find((line) => stripAnsi(line).includes("70.6% 192k/272k")) ?? "";

		expect(ctxLine).toContain("\x1b[33m70.6% 192k/272k\x1b[39m");
	});
});

describe("renderEditorTopStatus", () => {
	test("renders model status badges immediately after thinking level", () => {
		const line = renderEditorTopStatus(
			state({ thinkingLevel: "high", modelStatusBadges: ["fast"] }),
			config,
			"/tmp/p",
			theme,
			80,
		);

		expect(stripAnsi(line)).toContain("m > high > fast");
	});

	test("drops segments as the available width shrinks, then hides entirely", () => {
		const topStatus = (width: number) =>
			stripAnsi(
				renderEditorTopStatus(
					state({
						branch: "feature/long-branch-name",
						modelLabel: "model-name",
						thinkingLevel: "high",
						runtime: { name: "nodejs", symbol: "node", version: "v22.21.1" },
					}),
					config,
					"/home/user/projects/deep/my-project",
					theme,
					width,
				),
			).trimEnd();

		expect(topStatus(99)).toBe(
			"/home/user/projects/deep/my-project > feature/long-branch-name > node v22.21.1 > model-name > high",
		);
		expect(topStatus(90)).toBe("/home/user/projects/deep/my-project > feature/long-branch-name > model-name > high");
		expect(topStatus(60)).toBe("my-project > feature/long-branch-name > model-name > high");
		expect(topStatus(40)).toBe("feature/long-branch-name > model-name");
		expect(topStatus(20)).toBe("model-name > high");
		expect(topStatus(11)).toBe("model-name");
		expect(topStatus(6)).toBe("");
	});
});
