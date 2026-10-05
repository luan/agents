import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "node:test";
import type { TUI, TuiInputListener } from "@earendil-works/pi-tui";
import { rgb } from "../src/color/palette.ts";
import { measureTerminalColors, terminalColorsRegistry } from "../src/terminal-colors.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => {
	mock.timers.reset();
	terminalColorsRegistry().publish(undefined);
});

describe("terminal color detection", () => {
	test("rejects stale or malformed cross-realm profiles", () => {
		expect(() => terminalColorsRegistry().publish({ scheme: "dark", harmonious: true } as never)).toThrow(
			"Invalid pi-libtui terminal color measurements",
		);
		expect(() =>
			terminalColorsRegistry().publish({
				defaultBackground: { r: 1.5, g: 2, b: 3 },
				indexedPalette: "custom",
				scheme: "dark",
			}),
		).toThrow("Invalid pi-libtui terminal color measurements");
	});

	test("publishes an immutable snapshot of measured colors", () => {
		const defaultBackground = { r: 10, g: 20, b: 30 };
		const ansiBase16 = Array.from({ length: 16 }, () => ({ r: 40, g: 50, b: 60 }));
		terminalColorsRegistry().publish({
			defaultBackground,
			ansiBase16,
			indexedPalette: "custom",
			scheme: "dark",
		});
		defaultBackground.r = 200;
		ansiBase16[0]!.g = 200;
		expect(terminalColorsRegistry().current()?.defaultBackground).toEqual(rgb(10, 20, 30));
		expect(terminalColorsRegistry().current()?.ansiBase16?.[0]).toEqual(rgb(40, 50, 60));
	});

	test("detects a harmonious palette without consuming ordinary input", async () => {
		let listener: TuiInputListener | undefined;
		const writes: string[] = [];
		const tui = {
			terminal: {
				write(data: string) {
					writes.push(data);
					if (!data.includes("]4;16;?")) return;
					listener?.("\x1b]10;rgb:ee/ee/ee\x1b\\");
					listener?.("\x1b]4;16;rgb:1111/1111/1111\x1b\\");
					listener?.("\x1b]4;231;rgb:eeee/eeee/eeee\x1b\\");
				},
			},
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalColors: async () => ({ background: rgb(17, 17, 17), foreground: rgb(238, 238, 238) }),
		} as never as TUI;
		const profile = await measureTerminalColors(tui, 10);
		expect(profile.scheme).toBe("dark");
		expect(profile.indexedPalette).toBe("generated");
		expect(writes.some((value) => value.includes("]4;231;?"))).toBe(true);
	});

	test("frames split and batched replies while preserving residual input and consuming DA1", async () => {
		let listener: TuiInputListener | undefined;
		const listenerResults: ReturnType<TuiInputListener>[] = [];
		const tui = {
			terminal: {
				write(data: string) {
					if (!data.includes("]4;16;?")) return;
					listenerResults.push(listener?.("\x1b]10;rgb:aaaa/") as ReturnType<TuiInputListener>);
					listenerResults.push(
						listener?.(
							"bbbb/cccc\x1b\\left\x1b]4;16;rgb:1111/2222/3333\x07\x1b]4;231;rgb:dddd/eeee/ffff\x1b\\\x1b[?1;2cright",
						) as ReturnType<TuiInputListener>,
					);
				},
			},
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalColors: async () => ({ background: rgb(17, 17, 17) }),
		} as never as TUI;

		const profile = await measureTerminalColors(tui, 20);
		expect(profile.defaultForeground).toEqual(rgb(170, 187, 204));
		expect(profile.indexedPalette).toBe("custom");
		expect(profile).not.toHaveProperty("indexed16");
		expect(profile).not.toHaveProperty("indexed231");
		expect(listenerResults).toEqual([{ consume: true }, { data: "leftright" }]);
		expect(listener).toBeUndefined();
	});

	test("quarantines late color replies after timeout without swallowing adjacent input", async () => {
		let listener: TuiInputListener | undefined;
		const tui = {
			terminal: { write() {} },
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalColors: async () => ({}),
		} as never as TUI;

		const measured = measureTerminalColors(tui, 10);
		await Promise.resolve();
		mock.timers.tick(10);
		await measured;
		expect(listener?.("\x1b]10;rgb:11/22/33\x1b\\typed")).toEqual({ data: "typed" });
	});

	test("updates measurements when Pi's palette reply arrives after timeout", async () => {
		let onLateReply: Parameters<TUI["queryTerminalColors"]>[0]["onLateReply"];
		let listener: TuiInputListener | undefined;
		const tui = {
			terminal: {
				write() {
					listener?.("\x1b[?1;2c");
				},
			},
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalColors: async (options: Parameters<TUI["queryTerminalColors"]>[0]) => {
				onLateReply = options.onLateReply;
				return {};
			},
		} as never as TUI;
		const updates: Awaited<ReturnType<typeof measureTerminalColors>>[] = [];
		const initial = await measureTerminalColors(tui, 10, (profile) => updates.push(profile));
		expect(initial.ansiBase16).toBeUndefined();
		const palette = Array.from({ length: 16 }, (_, index) => rgb(index * 16, index * 8, index * 4));
		onLateReply?.({ background: palette[0], foreground: palette[15], palette });
		expect(updates).toEqual([
			{ ...initial, defaultBackground: palette[0], defaultForeground: palette[15], ansiBase16: palette },
		]);
	});

	test("updates late indexed anchors without swallowing adjacent input", async () => {
		let listener: TuiInputListener | undefined;
		const tui = {
			terminal: { write() {} },
			addInputListener(next: TuiInputListener) {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			queryTerminalColors: async () => ({ background: rgb(17, 17, 17), foreground: rgb(238, 238, 238) }),
		} as never as TUI;
		const updates: Awaited<ReturnType<typeof measureTerminalColors>>[] = [];
		const measured = measureTerminalColors(tui, 10, (profile) => updates.push(profile));
		await Promise.resolve();
		mock.timers.tick(10);
		expect((await measured).indexedPalette).toBe("unknown");
		expect(listener?.("\x1b]4;16;rgb:1111/1111/1111\x1b\\\x1b]4;231;rgb:eeee/eeee/eeee\x1b\\typed")).toEqual({
			data: "typed",
		});
		expect(updates.at(-1)?.indexedPalette).toBe("generated");
		mock.timers.tick(10);
		expect(listener).toBeUndefined();
	});
});
