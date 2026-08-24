import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyLiveTheme, applySavedSettings } from "../src/runtime/apply.ts";

function context(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		ui: { notify: () => {} },
		...overrides,
	} as unknown as ExtensionContext;
}

describe("applying saved settings", () => {
	test("applies a selected theme immediately", () => {
		const themes: string[] = [];
		const ctx = context({
			ui: {
				notify: () => {},
				setTheme: (theme: string) => {
					themes.push(theme);
					return { success: true };
				},
			},
		});

		expect(applyLiveTheme(ctx, "tokyo-night")).toBe(true);
		expect(themes).toEqual(["tokyo-night"]);
	});

	test("does not accept a theme Pi cannot apply", () => {
		const notifications: Array<[string, string]> = [];
		const ctx = context({
			ui: {
				notify: (message: string, level: string) => notifications.push([message, level]),
				setTheme: () => ({ success: false, error: "missing" }),
			},
		});

		expect(applyLiveTheme(ctx, "gone")).toBe(false);
		expect(notifications).toEqual([['Could not apply theme "gone": missing', "error"]]);
	});

	test("reloads after any saved setting changes", async () => {
		let reloads = 0;
		const ctx = context({
			reload: async () => {
				reloads += 1;
			},
		});

		await applySavedSettings(ctx, true);

		expect(reloads).toBe(1);
	});

	test("does nothing when the user made no changes", async () => {
		let reloads = 0;
		const ctx = context({
			reload: async () => {
				reloads += 1;
			},
		});

		await applySavedSettings(ctx, false);

		expect(reloads).toBe(0);
	});

	test("does not reload for settings that are already applied live", async () => {
		let reloads = 0;
		const ctx = context({
			reload: async () => {
				reloads += 1;
			},
		});
		await applySavedSettings(ctx, true, false);
		expect(reloads).toBe(0);
	});

	test("asks shortcut callers to reload", async () => {
		const notifications: Array<[string, string]> = [];
		const ctx = context({
			ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
		});

		await applySavedSettings(ctx, true);

		expect(notifications).toEqual([["Settings were saved. Run /reload to apply them to this session.", "info"]]);
	});
});
