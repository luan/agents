import { sliceByColumn } from "@earendil-works/pi-tui";

/**
 * Resolve the effective ANSI background at a visible terminal column.
 * @param line Styled terminal line to inspect.
 * @param column Zero-based visible column whose active background is needed.
 * @returns The last applicable background SGR sequence, or the default-background reset.
 */
export function backgroundAnsiAtColumn(line: string, column: number): string {
	const prefix = sliceByColumn(line, 0, Math.max(0, column) + 1, true);
	let background = "\x1b[49m";
	const sgr = /\x1b\[([0-9;]*)m/gu;
	for (const match of prefix.matchAll(sgr)) {
		const params = match[1] === "" ? [0] : match[1]!.split(";").map(Number);
		for (let index = 0; index < params.length; index += 1) {
			const code = params[index];
			if (code === undefined) continue;
			if (code === 0 || code === 49) {
				background = "\x1b[49m";
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				background = `\x1b[${code}m`;
			} else if (code === 48 && params[index + 1] === 5 && params[index + 2] !== undefined) {
				background = `\x1b[48;5;${params[index + 2]}m`;
				index += 2;
			} else if (code === 48 && params[index + 1] === 2 && params[index + 4] !== undefined) {
				background = `\x1b[48;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
				index += 4;
			} else if (code === 38) {
				// Skip extended foreground parameters. Their RGB/index values can
				// otherwise look like basic background codes in this scan (for
				// example `38;2;45;45;45m` contains the background code 45).
				if (params[index + 1] === 5 && params[index + 2] !== undefined) index += 2;
				else if (params[index + 1] === 2 && params[index + 4] !== undefined) index += 4;
			}
		}
	}
	return background;
}

/** Paint a cap with the exact background of a native rendered surface. */
export function nativeSurfaceCap(line: string, cap: string): string {
	const background = backgroundAnsiAtColumn(line, 0);
	const foreground = background.replace(/\[(\d+)/u, (_match, code: string) => `[${Number(code) - 10}`);
	return `\x1b[49m${foreground}${cap}\x1b[39m`;
}

export function indexedCell(index: number, text: string, background: boolean): string {
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
