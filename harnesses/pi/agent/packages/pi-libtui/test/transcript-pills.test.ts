import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	initTheme,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Terminal } from "@xterm/headless";
import { configureTuiAppearance, getTuiAppearance } from "../src/appearance.ts";
import { renderTranscriptPill } from "../src/decoration/transcript-pills.ts";

const theme = {
	name: "transcript-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;220;220;220m",
	getBgAnsi: () => "\x1b[48;2;30;34;42m",
} as never as Theme;
const appearance = getTuiAppearance();
afterEach(() => configureTuiAppearance(appearance));

test.each([20, 40, 80])("native user Markdown paints matching pill caps and body at %i columns", async (width) => {
	initTheme("dark", false);
	configureTuiAppearance({ powerline: true });
	const message = new UserMessageComponent("before ATTACHMENT after", undefined, 1, [
		(text, context) =>
			text.replace(
				"ATTACHMENT",
				renderTranscriptPill(theme, { icon: "view-image", label: "Image #1" }, context.availableWidth),
			),
	]);
	const rendered = message.render(width);
	expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
	const row = rendered.find((line) => line.includes("Image"))!;
	const plain = stripTerminalSequences(row);
	expect(plain.replaceAll("\u00a0", " ")).toContain("Image #1");
	// An unrelated overlay must not change the surviving pill's paint.
	for (const line of [row, compositeTuiLine(row, "x", width - 1, 1, width)]) {
		const terminal = new Terminal({ cols: width, rows: 2, allowProposedApi: true });
		try {
			await new Promise<void>((resolve) => terminal.write(line, resolve));
			const cells = terminal.buffer.active.getLine(0)!;
			const left = cells.getCell(visibleWidth(plain.slice(0, plain.indexOf(""))))!;
			const body = cells.getCell(visibleWidth(plain.slice(0, plain.indexOf("Image"))))!;
			const right = cells.getCell(visibleWidth(plain.slice(0, plain.indexOf(""))))!;
			expect(left.getFgColor()).toBe(body.getBgColor());
			expect(right.getFgColor()).toBe(body.getBgColor());
			expect(body.getFgColor()).not.toBe(body.getBgColor());
		} finally {
			terminal.dispose();
		}
	}
});

test("queued pill icons, labels, and following text are dim without leaking their background", async () => {
	configureTuiAppearance({ powerline: true });
	const queuedTheme = {
		...theme,
		getFgAnsi: (token: string) => (token === "dim" ? "\x1b[38;2;80;80;80m" : "\x1b[38;2;220;220;220m"),
	} as Theme;
	const line = `${renderTranscriptPill(queuedTheme, { icon: "view-image", label: "Image #1" }, 80, true)} after`;
	const terminal = new Terminal({ cols: 80, rows: 2, allowProposedApi: true });
	try {
		await new Promise<void>((resolve) => terminal.write(line, resolve));
		const cells = terminal.buffer.active.getLine(0)!;
		const plain = stripTerminalSequences(line);
		const cell = (text: string) => cells.getCell(visibleWidth(plain.slice(0, plain.indexOf(text))))!;
		expect(cell("Image").getFgColor()).toBe(0x505050);
		expect(cell("after").getFgColor()).toBe(0x505050);
		expect(cell("after").isBgDefault()).toBe(true);
		expect(cell("").getFgColor()).toBe(cell("Image").getBgColor());
	} finally {
		terminal.dispose();
	}
});

test.each([20, 80])("assistant pills keep literal titles and matching paint at %i columns", async (width) => {
	initTheme("dark", false);
	configureTuiAppearance({ powerline: true });
	const message: AssistantMessage = {
		role: "assistant",
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		timestamp: 0,
		stopReason: "stop",
		content: [{ type: "text", text: "before CITATION after" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const title = "API [v2] $5 *x* ```z```";
	const component = new AssistantMessageComponent(message, true, undefined, undefined, 0, [
		(text, context) =>
			text.replace(
				"CITATION",
				renderTranscriptPill(theme, { icon: "search", label: title }, context.availableWidth, false, {
					surface: "assistant",
					href: "https://example.com/?q=```",
				}),
			),
	]);
	const lines = component.render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	const row = lines.find((line) => line.includes("API"))!;
	const plain = stripTerminalSequences(row).replaceAll("\u00a0", " ");
	expect(plain).toContain(width === 20 ? "API [v2]" : title);
	const terminal = new Terminal({ cols: width, rows: 2, allowProposedApi: true });
	try {
		await new Promise<void>((resolve) => terminal.write(row, resolve));
		const cells = terminal.buffer.active.getLine(0)!;
		const at = (text: string) => cells.getCell(visibleWidth(plain.slice(0, plain.indexOf(text))))!;
		expect(at("").getFgColor()).toBe(at("API").getBgColor());
		expect(at("").getFgColor()).toBe(at("API").getBgColor());
		if (width === 20) expect(at("…").getBgColor()).toBe(at("API").getBgColor());
		else expect(at("after").isBgDefault()).toBe(true);
	} finally {
		terminal.dispose();
	}
});
