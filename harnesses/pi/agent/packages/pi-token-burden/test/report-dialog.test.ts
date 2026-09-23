import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	type OverlayOptions,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { DialogHost } from "@luan.sh/pi-libtui";
import { createReportDialog, openReportDialog } from "../src/ui/report-dialog.ts";

const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s, bg: (_: string, s: string) => s } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

function capture() {
	let child: Component | undefined;
	let options: OverlayOptions | undefined;
	let closed = 0;
	const host: DialogHost = {
		open(component, next) {
			child = component;
			options = next;
			return () => {
				closed += 1;
			};
		},
	};
	return { host, child: () => child!, options: () => options, closed: () => closed };
}

describe("ReportDialog", () => {
	test("routes scrolling and close keys through the captured modal child", () => {
		const captured = capture();
		let dismissed = 0;
		const dialog = createReportDialog({
			theme,
			keybindings: keys,
			requestRender() {},
			title: "Detail",
			content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
			onClose: () => dismissed++,
		});
		openReportDialog(captured.host, dialog);
		captured.child().render?.(30);
		captured.child().handleInput?.("\x1b[F");
		const end = stripTerminalSequences(captured.child().render(30).join("\n"));
		expect(end).toContain("line 39");
		captured.child().handleInput?.("\x1b");
		expect(dismissed).toBe(1);
	});

	test("sanitizes raw controls and clamps every rendered row after resize", () => {
		const dialog = createReportDialog({
			theme,
			keybindings: keys,
			requestRender() {},
			title: "Detail",
			content: `safe\u001b[2J\u001b]8;;evil\u0007\n${"x".repeat(100)}`,
			onClose() {},
		});
		dialog.setMaxHeight(1);
		for (const height of [0, 1, 2, 8]) {
			dialog.setMaxHeight(height);
			const lines = dialog.render(5);
			expect(lines.length).toBeLessThanOrEqual(Math.max(1, height));
			expect(lines.every((line) => visibleWidth(line) <= 5)).toBe(true);
			expect(lines.join("\n")).not.toContain("\u001b[2J");
		}
	});

	test("reads the height getter on every render", () => {
		let height = 6;
		const dialog = createReportDialog({
			theme,
			keybindings: keys,
			requestRender() {},
			title: "Detail",
			content: "one\ntwo\nthree\nfour",
			height: () => height,
			onClose() {},
		});
		expect(dialog.render(20).length).toBeLessThanOrEqual(6);
		height = 2;
		expect(dialog.render(20).length).toBeLessThanOrEqual(2);
	});
});
