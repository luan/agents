import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { PromptItem, PromptStorageConfig } from "../src/core/model.ts";
import { createStashPicker, openPromptPicker, type PickerResult } from "../src/ui/picker.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
} as Theme;
const config: PromptStorageConfig = {
	shortcuts: { stash: "ctrl+s" },
	history: { includeSlashCommands: false, maxResults: 100 },
	picker: { maxVisible: 8, enterAction: "pop" },
};
const items: PromptItem[] = [
	{ kind: "stash", id: 2, text: "latest editor draft", timestamp: 2, cwd: "/repo" },
	{ kind: "stash", id: 1, text: "older database draft", timestamp: 1, cwd: "/repo" },
];

function picker(results: Array<PickerResult | null>) {
	return createStashPicker(
		{ terminal: { rows: 20 }, requestRender() {} },
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(result) => results.push(result),
		items,
		config,
	);
}

describe("stash picker", () => {
	test("uses the shared role-picker panel with Vim navigation and slash filtering", () => {
		const results: Array<PickerResult | null> = [];
		const panel = picker(results);
		const visible = stripTerminalSequences(panel.render(100).join("\n"));

		expect(visible).toContain("Prompt Stash 1/2");
		expect(visible).toContain("/ search");
		expect(visible).toContain("Pop");
		expect(visible).toContain("ctrl+a apply · ctrl+x drop");

		panel.handleInput("j");
		panel.handleInput("\r");
		expect(results).toEqual([{ item: items[1], action: "pop" }]);

		const filteredResults: Array<PickerResult | null> = [];
		const filtered = picker(filteredResults);
		filtered.focused = true;
		filtered.handleInput("/");
		for (const character of "database") filtered.handleInput(character);
		expect(stripTerminalSequences(filtered.render(100).join("\n"))).not.toContain("latest editor draft");
		filtered.handleInput("\r");
		expect(filteredResults).toEqual([{ item: items[1], action: "pop" }]);
	});

	test("keeps apply and drop actions on the selected stash", () => {
		const applied: Array<PickerResult | null> = [];
		picker(applied).handleInput("\x01");
		expect(applied).toEqual([{ item: items[0], action: "apply" }]);

		const dropped: Array<PickerResult | null> = [];
		picker(dropped).handleInput("\x18");
		expect(dropped).toEqual([{ item: items[0], action: "drop", selectionAfterDrop: items[1]!.id }]);
	});

	test("reopens on the row above a dropped stash", () => {
		const stashes: PromptItem[] = [
			{ kind: "stash", id: 4, text: "four", timestamp: 4, cwd: "/repo" },
			{ kind: "stash", id: 3, text: "three", timestamp: 3, cwd: "/repo" },
			{ kind: "stash", id: 2, text: "two", timestamp: 2, cwd: "/repo" },
			{ kind: "stash", id: 1, text: "one", timestamp: 1, cwd: "/repo" },
		];
		const results: Array<PickerResult | null> = [];
		const selected = createStashPicker(
			{ terminal: { rows: 20 }, requestRender() {} },
			theme,
			new KeybindingsManager(TUI_KEYBINDINGS),
			(result) => results.push(result),
			stashes,
			config,
			2,
		);
		selected.handleInput("\x18");
		expect(results).toEqual([{ item: stashes[2], action: "drop", selectionAfterDrop: 3 }]);

		const reopened = createStashPicker(
			{ terminal: { rows: 20 }, requestRender() {} },
			theme,
			new KeybindingsManager(TUI_KEYBINDINGS),
			() => {},
			stashes.filter((item) => item.id !== 2),
			config,
			3,
		);
		expect(stripTerminalSequences(reopened.render(80).join("\n"))).toContain("Prompt Stash 2/3");
	});

	test("anchors the stash panel beside the editor like the role picker", async () => {
		let options: { overlay?: boolean; overlayOptions?: { anchor?: string; width?: string } } | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				custom: (_factory: object, next: typeof options) => {
					options = next;
					return Promise.resolve(null);
				},
			},
		} as never as ExtensionContext;
		await openPromptPicker(ctx, "Prompt Stash", items, config, "stash", {
			progress: () => undefined,
			watch: () => () => {},
		});

		expect(options).toEqual({ overlay: true, overlayOptions: { anchor: "bottom-left", width: "100%" } });
	});
});
