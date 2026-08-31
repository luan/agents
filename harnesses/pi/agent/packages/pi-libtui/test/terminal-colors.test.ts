import { afterEach, describe, expect, test } from "bun:test";
import type { TUI, TuiInputListener } from "@earendil-works/pi-tui";
import { rgb } from "../src/color/palette.ts";
import { measureTerminalColors, terminalColorsRegistry } from "../src/terminal-colors.ts";

afterEach(() => terminalColorsRegistry().publish(undefined));

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
					if (!data.includes("]10;?")) return;
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
			queryTerminalBackgroundColor: async () => rgb(17, 17, 17),
			queryTerminalColorScheme: async () => "dark",
		} as never as TUI;
		const profile = await measureTerminalColors(tui, 10);
		expect(profile.scheme).toBe("dark");
		expect(writes.some((value) => value.includes("]4;231;?"))).toBe(true);
	});

	test("frames split and batched replies while preserving residual input and consuming DA1", async () => {
		let listener: TuiInputListener | undefined;
		const listenerResults: ReturnType<TuiInputListener>[] = [];
		const tui = {
			terminal: {
				write(data: string) {
					if (!data.includes("]10;?")) return;
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
			queryTerminalBackgroundColor: async () => rgb(17, 17, 17),
			queryTerminalColorScheme: async () => "dark",
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
			queryTerminalBackgroundColor: async () => undefined,
			queryTerminalColorScheme: async () => undefined,
		} as never as TUI;

		await measureTerminalColors(tui, 10);
		expect(listener?.("\x1b]10;rgb:11/22/33\x1b\\typed")).toEqual({ data: "typed" });
	});
});
