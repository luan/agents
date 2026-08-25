import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { color256Index } from "./palette.ts";

type ChannelMask = readonly [red: boolean, green: boolean, blue: boolean];

const HUE_EDGES: readonly ChannelMask[] = [
	[true, false, false],
	[true, true, false],
	[false, true, false],
	[false, true, true],
	[false, false, true],
	[true, false, true],
];

/** Width of the upstream color256 terminal preview, including its base16 legend. */
export const COLOR256_PREVIEW_WIDTH = 69;

/**
 * Render the active terminal's 256-color palette in color256's perceptual grid.
 * Layout ported from the public-domain `preview_theme` implementation:
 * https://github.com/jake-stewart/color256/blob/master/color256.py
 */
export function renderColor256Preview(name: string): string[] {
	const grays = grayCells(24, 6);
	const colors = [
		...colorSlices({ reverse: true, includeFinal: true, background: true }),
		...colorSlices({ reverse: false, includeFinal: false, background: false }),
	];
	const body = grays.map((gray, row) => `${gray}${colors[row] ?? ""}${gray}`);
	const title = `${grayCells(5, 0).join("")}${center(name.slice(0, 24), 24)}${grayCells(0, 5).join("")}`;
	const grid = [...body, title];
	const legend = base16Legend();
	return grid.map((line, row) => `${line}   ${legend[row] ?? "      "}`);
}

/** Focusable screen used by the `/libtui:colors` diagnostic command. */
export class Color256Preview implements Component, Focusable {
	focused = false;

	constructor(
		private readonly theme: Theme,
		private readonly close: () => void,
	) {}

	render(): string[] {
		return renderColor256Preview(this.theme.name ?? "Active Theme");
	}

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, "escape")) this.close();
	}

	invalidate(): void {}
}

interface SliceOptions {
	reverse: boolean;
	includeFinal: boolean;
	background: boolean;
}

function colorSlices(options: SliceOptions): string[] {
	const columns: string[][] = [];
	for (let edge = 0; edge < HUE_EDGES.length; edge += 1) {
		const current = HUE_EDGES[edge]!;
		const next = HUE_EDGES[(edge + 1) % HUE_EDGES.length]!;
		for (let step = 0; step < 3; step += 1) {
			columns.push(
				colorSlice(
					[...Array.from({ length: 3 - step }, () => current), ...Array.from({ length: step }, () => next)],
					options,
				),
			);
		}
	}
	const rows = Array.from({ length: columns[0]?.length ?? 0 }, () => "");
	for (const column of columns) {
		for (let row = 0; row < rows.length; row += 1) rows[row] += column[row] ?? "   ";
	}
	return rows;
}

function colorSlice(masks: readonly ChannelMask[], options: SliceOptions): string[] {
	const cells: string[] = [];
	for (let level = 1; level < 6; level += 1) {
		const [red, green, blue] = averageChannels(masks, level, false);
		const brightness = Math.floor(((red + green + blue) / 15) * 16).toString(16);
		cells.push(indexedCell(color256Index(red, green, blue), ` ${brightness} `, options.background));
	}
	for (let level = 1; level < (options.includeFinal ? 6 : 5); level += 1) {
		const [red, green, blue] = averageChannels(masks, level, true);
		const brightness = Math.floor(((red + green + blue) / 16) * 16).toString(16);
		cells.push(indexedCell(color256Index(red, green, blue), ` ${brightness} `, options.background));
	}
	if (options.reverse) cells.reverse();
	return cells;
}

function averageChannels(masks: readonly ChannelMask[], level: number, inverted: boolean): [number, number, number] {
	const channels = [0, 0, 0];
	for (const mask of masks) {
		for (let channel = 0; channel < 3; channel += 1) {
			channels[channel] += mask[channel] ? (inverted ? 5 : level) : inverted ? level : 0;
		}
	}
	return channels.map((value) => Math.floor(value / masks.length)) as [number, number, number];
}

function grayCells(from: number, to: number): string[] {
	const direction = from <= to ? 1 : -1;
	const cells: string[] = [];
	for (let shade = from; shade !== to + direction; shade += direction) {
		const index = shade === 24 ? 231 : 232 + shade;
		const label = Math.min(15, Math.floor((shade / 24) * 16)).toString(16);
		cells.push(indexedCell(index, ` ${label} `, true));
	}
	return cells;
}

function base16Legend(): string[] {
	return [
		"      ",
		...Array.from(
			{ length: 8 },
			(_, index) =>
				`${indexedCell(index, ` ${index.toString(16)} `, true)}${indexedCell(index + 8, ` ${(index + 8).toString(16)} `, true)}`,
		),
		"      ",
		"      ",
		...Array.from(
			{ length: 8 },
			(_, index) =>
				`${indexedCell(index, ` ${index.toString(16)} `, false)}${indexedCell(index + 8, ` ${(index + 8).toString(16)} `, false)}`,
		),
		"      ",
	];
}

function center(text: string, width: number): string {
	const left = Math.floor((width - text.length) / 2);
	return `${" ".repeat(left)}${text}${" ".repeat(width - left - text.length)}`;
}

function indexedCell(index: number, text: string, background: boolean): string {
	if (!background) return `\x1b[38;5;${index}m${text}\x1b[0m`;
	return isDark(index) ? `\x1b[48;5;${index}m${text}\x1b[0m` : `\x1b[38;5;${index};7m${text}\x1b[0m`;
}

function isDark(index: number): boolean {
	if (index >= 16 && index <= 231) {
		const cube = index - 16;
		return Math.floor(cube / 36) < 4 && Math.floor(cube / 6) % 6 < 4 && cube % 6 < 4;
	}
	if (index >= 232) return index - 232 < 11;
	return index % 8 === 0;
}
