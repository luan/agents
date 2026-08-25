import { afterEach, describe, expect, test } from "bun:test";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE } from "../src/appearance.ts";
import { icon, renderPillText } from "../src/decoration/glyphs.ts";

describe("semantic icons", () => {
	afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

	test("selects semantic icons from each supported pack", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts" });
		expect(icon("reset")).toBe("");
		expect(icon("close")).toBe("󰿅");
		expect(icon("confirm")).toBe("");
		expect(icon("search")).toBe("");
		expect(icon("developer")).toBe("󱔘");
		expect(icon("user")).toBe("󰷈");
		expect(icon("ux")).toBe("󰮄");
		expect(icon("animations")).toBe("");

		configureTuiAppearance({ iconPack: "unicode" });
		expect(icon("comment")).toBe("✎");
		expect(icon("delete")).toBe("×");
		expect(icon("reset")).toBe("↺");
		expect(icon("close")).toBe("×");

		configureTuiAppearance({ iconPack: "emoji" });
		expect(icon("comment")).toBe("💬");
		expect(icon("delete")).toBe("🗑️");
	});

	test("uses flat block caps when Powerline separators are disabled", () => {
		configureTuiAppearance({ iconPack: "unicode", powerline: false, powerlineButtons: false });
		expect(renderPillText({ icon: "comment", label: "label" })).toBe("▐✎ label▌");
	});
});
