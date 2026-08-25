import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { FullscreenOverlay, MultiSelect, SearchableSelect, TabBar } from "../src/index.ts";

describe("shared TUI components", () => {
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg>`,
		underline: (text: string) => text,
	} as Theme;

	function initializeTui(): void {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	}

	test("tabs use h/l and arrows and reset inactive backgrounds on both sides", () => {
		const selected: string[] = [];
		const tabs = new TabBar(
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
			theme,
		);
		tabs.onChange = (tab) => selected.push(tab.id);

		tabs.handleInput("l");
		expect(selected).toEqual(["b"]);
		const rendered = tabs.render(80)[0]!;
		expect(rendered.match(/\x1b\[49m/g)?.length).toBeGreaterThanOrEqual(3);
		tabs.handleInput("h");
		tabs.handleInput("\x1b[D");
		tabs.handleInput("\x1b[C");
		expect(selected).toEqual(["b", "a", "c", "a"]);
	});

	test("fullscreen overlay draws a border without applying a panel background", () => {
		const child = { render: () => ["content"], invalidate() {} };
		const overlay = new FullscreenOverlay({ terminal: { rows: 4 } } as never, theme, child, "Settings");
		const rendered = overlay.render(30).join("\n");

		expect(rendered).toContain("╭─ Settings");
		expect(rendered).toContain("│content");
		expect(rendered).toContain("╰");
		expect(rendered).not.toContain("<bg:");
	});

	test("searchable select navigates immediately and filters only after slash", () => {
		initializeTui();
		const selected: string[] = [];
		const select = new SearchableSelect({
			title: "Mode",
			options: [
				{ value: "default", label: "Default" },
				{ value: "minimal", label: "Minimal" },
			],
			selected: "default",
			theme,
			onSelect: (value) => selected.push(value),
			onCancel() {},
		});

		select.handleInput("j");
		select.handleInput("\r");
		expect(selected).toEqual(["minimal"]);
		const filtered = new SearchableSelect({
			title: "Mode",
			options: [
				{ value: "default", label: "Default" },
				{ value: "minimal", label: "Minimal" },
			],
			theme,
			onSelect() {},
			onCancel() {},
		});
		filtered.handleInput("/");
		for (const character of "min") filtered.handleInput(character);
		expect(stripTerminalSequences(filtered.render(60).join("\n"))).toContain("Minimal");
		expect(stripTerminalSequences(filtered.render(60).join("\n"))).not.toContain("Default");
	});

	test("multi-select saves order and warns before discarding changes", () => {
		initializeTui();
		const saved: string[][] = [];
		let cancelled = false;
		const select = new MultiSelect({
			title: "Models",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			value: ["b", "a"],
			ordered: true,
			theme,
			onSave: (value) => saved.push(value),
			onCancel: () => {
				cancelled = true;
			},
		});

		select.handleInput("l");
		expect(stripTerminalSequences(select.render(60).join("\n")).indexOf("A")).toBeLessThan(
			stripTerminalSequences(select.render(60).join("\n")).indexOf("B"),
		);
		select.handleInput("\x1b");
		expect(select.render(60).join("\n")).toContain("Unsaved changes");
		expect(cancelled).toBe(false);
		select.handleInput("\r");
		expect(saved).toEqual([["a", "b"]]);
	});
});
