import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mountScreenIconActions } from "../src/controls/screen-icon-actions.ts";
import { getMouseRegistryState } from "../src/mouse/registry.ts";
import { ensureMouseRegistry } from "../src/mouse.ts";

const theme = {
	name: "screen-actions-test",
	bold: (text: string) => text,
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

test("mounts icon-only top-right actions with pointer tooltips", () => {
	const registry = ensureMouseRegistry(Object.create(null) as typeof globalThis);
	const activated: string[] = [];
	let visible = true;
	const mount = mountScreenIconActions({
		id: "test.actions",
		theme,
		registry,
		actions: [
			{ value: "expand", glyph: "󰘖", tooltip: "Expand side panel", shortcuts: ["alt+shift+z"], visible: () => visible },
			{ value: "toggle", glyph: "", tooltip: "Hide side panel" },
		],
		onActivate: (value) => activated.push(value),
	});
	const blank = Array.from({ length: 6 }, () => " ".repeat(40));
	const context = { width: 40, height: 6, hasOverlay: false } as const;
	const rendered = Bun.stripANSI(registry.dispatchScreenDecorators(blank, context).join("\n"));
	expect(rendered.split("\n")[0]).toContain("󰘖");
	expect(rendered.split("\n")[0]).toContain("");
	expect(rendered).not.toContain("Expand side panel");
	expect(mount.reservedWidth).toBe(7);

	const expand = getMouseRegistryState(registry).regions.find((region) => region.id === "test.actions.expand");
	expect(expand?.getRect()?.y).toBe(0);
	expand?.onMouse(mouse("move"));
	const hovered = Bun.stripANSI(registry.dispatchScreenDecorators(blank, context).join("\n"));
	expect(hovered).toContain("Expand side panel");
	expect(hovered).toContain("⌥");
	expect(hovered).toContain("⇧");
	expect(hovered).not.toContain("╭");
	expand?.onMouse(mouse("release"));
	expect(activated).toEqual(["expand"]);
	expand?.onMouse(mouse("press"));
	expand?.onMouse(mouse("release"));
	expect(activated).toEqual(["expand", "expand"]);

	visible = false;
	registry.dispatchScreenDecorators(blank, context);
	expect(expand?.getRect()).toBeUndefined();
	mount.dispose();
});

function mouse(type: "move" | "press" | "release") {
	return {
		type,
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: type === "move" ? undefined : (0 as const),
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	} as const;
}
