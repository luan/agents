import { afterEach, beforeEach, expect, test } from "bun:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, stripTerminalSequences, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { Terminal as VirtualTerminal } from "@xterm/headless";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { backgroundAnsiAtColumn } from "../src/decoration/powerline-pill.ts";
import { installUserMessageBridge } from "../src/host/user-message-bridge.ts";

const disposers: Array<() => void> = [];

class CapturedTerminal extends ProcessTerminal {
	output = "";
	width = 80;
	override get columns() {
		return this.width;
	}
	override get rows() {
		return 24;
	}
	override start(): void {}
	override stop(): void {}
	override write(data: string): void {
		this.output += data;
	}
}

test("incremental bubble redraws match clean frames after overlays, resizing, and content changes", async () => {
	disposers.push(installUserMessageBridge());
	configureTuiAppearance({ userMessageBubbles: true });
	const terminal = new CapturedTerminal();
	const tui = new TuiAltScreen(terminal);
	const screen = new VirtualTerminal({ cols: terminal.columns, rows: terminal.rows, allowProposedApi: true });
	const snapshot = (target: VirtualTerminal) =>
		Array.from({ length: target.rows }, (_, row) => target.buffer.active.getLine(row)?.translateToString(true));
	const checkFrame = async () => {
		tui.renderNow();
		await new Promise<void>((resolve) => screen.write(terminal.output, resolve));
		terminal.output = "";
		tui.renderNow(true);
		const clean = new VirtualTerminal({ cols: terminal.columns, rows: terminal.rows, allowProposedApi: true });
		try {
			await new Promise<void>((resolve) => clean.write(terminal.output, resolve));
			expect(snapshot(screen)).toEqual(snapshot(clean));
		} finally {
			clean.dispose();
			terminal.output = "";
		}
	};
	try {
		for (let index = 0; index < 12; index++)
			tui.addChild(new UserMessageComponent(`Message ${index} **with formatting**`));
		tui.start();
		await checkFrame();
		const overlay = tui.showOverlay(new Text("Settings\nCursor\nImages\nCodex Native", 1, 1), { width: 45 });
		await checkFrame();
		overlay.hide();
		await checkFrame();
		terminal.width = 45;
		screen.resize(45, terminal.rows);
		await checkFrame();
		tui.clear();
		tui.addChild(new UserMessageComponent("ship"));
		await checkFrame();
		configureTuiAppearance({ userMessageBubbles: false });
		await checkFrame();
	} finally {
		tui.stop();
		screen.dispose();
	}
});
beforeEach(() => initTheme("dark", false));
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
});

test("fullscreen bubbles do not emit terminal transcript zone markers", () => {
	disposers.push(installUserMessageBridge());
	configureTuiAppearance({ userMessageBubbles: true });
	const terminal = new CapturedTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild(new UserMessageComponent("ship"));
	try {
		tui.start();
		tui.renderNow();
		expect(terminal.output).toContain("ship");
		expect(terminal.output).not.toContain("\x1b]133;");
	} finally {
		tui.stop();
	}
});

test("compact half-block bubbles toggle live without changing native messages", () => {
	configureTuiAppearance({ userMessageBubbles: false });
	const message = new UserMessageComponent("Hello **world** — 你好 👋");
	const native = message.render(100);
	const remove = installUserMessageBridge();
	disposers.push(remove);
	expect(message.render(100)).toEqual(native);
	configureTuiAppearance({ userMessageBubbles: true, iconPack: "nerd-fonts" });
	const lines = message.render(100);
	expect(lines).toHaveLength(3);
	expect(lines[0]).toContain("▄");
	expect(lines[2]).toContain("▀");
	expect(stripTerminalSequences(lines[1]!).trimStart()).toBe("█ Hello world — 你好 👋 █");
	expect(visibleWidth(lines[0]!)).toBe(100);
	configureTuiAppearance({ iconPack: "unicode" });
	expect(message.render(100)).toEqual(lines);
	configureTuiAppearance({ userMessageBubbles: false });
	expect(message.render(100)).toEqual(native);
	configureTuiAppearance({ userMessageBubbles: true });
	remove();
	expect(message.render(100)).toEqual(native);
});

test.each([
	["ship", 8],
	["**ship**", 8],
	["你好 👋", 11],
	["first\n\nsecond", 10],
] as const)("fits the rendered content of %s", (text, expectedWidth) => {
	const message = new UserMessageComponent(text);
	disposers.push(installUserMessageBridge());
	configureTuiAppearance({ userMessageBubbles: true, iconPack: "nerd-fonts" });
	const lines = message.render(100).map(stripTerminalSequences);
	for (const line of lines) {
		expect(visibleWidth(line)).toBe(100);
		expect(visibleWidth(line.trimStart())).toBe(expectedWidth);
	}
});

test.each([20, 39, 40, 81, 120])("wraps within 60 columns with half-block edges at %i", (width) => {
	const message = new UserMessageComponent("Wide 字 and words with **emphasis**. ".repeat(12));
	const bubbleWidth = Math.min(60, width < 40 ? width : Math.floor(width * 0.75));
	const native = message.render(bubbleWidth - 2);
	const expectedHeight = native.length;
	disposers.push(installUserMessageBridge());
	configureTuiAppearance({ userMessageBubbles: true, iconPack: "nerd-fonts" });
	const lines = message.render(width);
	expect(lines).toHaveLength(expectedHeight);
	expect(lines.slice(1, -1).map((line) => stripTerminalSequences(line).trim().slice(1, -1).trimEnd())).toEqual(
		native.slice(1, -1).map((line) => stripTerminalSequences(line).trimEnd()),
	);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	expect(lines[0]).toContain("▄");
	expect(lines[1]).toContain("█");
	const gutter = width - visibleWidth(stripTerminalSequences(lines[1]!).trimStart());
	const bodyBackground = backgroundAnsiAtColumn(lines[1]!, gutter + 2);
	expect(bodyBackground).not.toBe("\x1b[49m");
	for (const line of lines.slice(1, -1)) {
		for (const column of [gutter + 1, gutter + 2, width - 2]) {
			expect(backgroundAnsiAtColumn(line, column)).toBe(bodyBackground);
		}
	}
	expect(lines.at(-1)).toContain("▀");
	expect(lines.at(-1)).toContain("\x1b]133;B\x07\x1b]133;C\x07");
});

test("duplicate installs release independently", () => {
	const message = new UserMessageComponent("hello");
	const native = message.render(80);
	const first = installUserMessageBridge();
	const second = installUserMessageBridge();
	disposers.push(first, second);
	configureTuiAppearance({ userMessageBubbles: true, iconPack: "nerd-fonts" });
	expect(message.render(80)).toHaveLength(3);
	first();
	first();
	expect(message.render(80)).toHaveLength(3);
	second();
	expect(message.render(80)).toEqual(native);
});
