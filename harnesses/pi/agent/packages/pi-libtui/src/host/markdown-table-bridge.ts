import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, sliceByColumn } from "@earendil-works/pi-tui";
import { tuiTheme } from "../color/theme.ts";

const PROTOCOL = "pi-libtui/markdown-table-bridge/v1" as const;
const KEY = Symbol.for(PROTOCOL);

// Only column count is inspected; Pi retains ownership of tokens and inline styling.
interface NativeTableToken {
	readonly header: readonly object[];
}

type NativeTableRenderer = (
	this: Markdown,
	token: NativeTableToken,
	width: number,
	nextTokenType?: string,
	styleContext?: object,
) => string[];

interface TableBridge {
	readonly protocol: typeof PROTOCOL;
	acquire(theme: () => Theme): () => void;
}

// type-boundary: Reflect reads Pi's private table method and installed libtui leases; isRenderer and isBridge validate them.
type UntrustedTableCapability = unknown;

function isBridge(value: UntrustedTableCapability): value is TableBridge {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TableBridge>;
	return candidate.protocol === PROTOCOL && typeof candidate.acquire === "function";
}

function isRenderer(value: UntrustedTableCapability): value is NativeTableRenderer {
	return typeof value === "function";
}

/** Pi 1.0 has no table-layout API. Retire this lease when native Markdown exposes one. */
export function installMarkdownTableBridge(getTheme: () => Theme): () => void {
	const prototype = Markdown.prototype;
	const existing: UntrustedTableCapability = Reflect.get(prototype, KEY);
	if (isBridge(existing)) return existing.acquire(getTheme);
	const native: UntrustedTableCapability = Reflect.get(prototype, "renderTable");
	if (!isRenderer(native)) return () => {};
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "renderTable");
	if (!descriptor?.configurable) return () => {};
	const themes = new Map<symbol, () => Theme>();
	const render: NativeTableRenderer = function (token, width, nextTokenType, styleContext) {
		const columns = token.header.length;
		// One cell padding column per side, two columns between cells; keep Pi's narrow fallback.
		if (columns === 0 || width < 5 * columns - 2) {
			return native.call(this, token, width, nextTokenType, styleContext);
		}
		const lines = native.call(this, token, width - (columns - 3), nextTokenType, styleContext);
		const widths = tableWidths(lines[0] ?? "", columns);
		const theme = Array.from(themes.values()).at(-1)?.();
		if (!widths || !theme) return native.call(this, token, width, nextTokenType, styleContext);
		return openTable(lines, widths, theme);
	};
	const bridge: TableBridge = {
		protocol: PROTOCOL,
		acquire(theme) {
			const owner = Symbol();
			themes.set(owner, theme);
			return () => {
				if (!themes.delete(owner) || themes.size > 0) return;
				if (Reflect.get(prototype, "renderTable") === render) {
					Object.defineProperty(prototype, "renderTable", descriptor);
				}
				if (Reflect.get(prototype, KEY) === bridge) Reflect.deleteProperty(prototype, KEY);
			};
		},
	};
	Object.defineProperty(prototype, "renderTable", { ...descriptor, value: render });
	Object.defineProperty(prototype, KEY, { configurable: true, value: bridge });
	return bridge.acquire(getTheme);
}

function tableWidths(top: string, columns: number): number[] | undefined {
	if (!/^┌─+(?:┬─+)*┐$/u.test(top)) return undefined;
	const widths = top
		.slice(1, -1)
		.split("┬")
		.map((segment) => segment.length - 2);
	return widths.length === columns && widths.every((width) => width > 0) ? widths : undefined;
}

function openTable(lines: readonly string[], widths: readonly number[], theme: Theme): string[] {
	const colors = tuiTheme(theme);
	const separator = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
	const bottom = separator.replace("├", "└").replaceAll("┼", "┴").replace("┤", "┘");
	const rule = colors.fg("border", widths.map((width) => "─".repeat(width + 2)).join("  "));
	let header = true;
	const result: string[] = [];
	for (const line of lines.slice(1)) {
		if (line === bottom) continue;
		if (line === separator) {
			header = false;
			result.push(rule);
		} else if (line.startsWith("│ ")) {
			let column = 1;
			const cells = widths.map((width) => {
				const cell = sliceByColumn(line, column, width + 2);
				column += width + 3;
				return header ? colors.fg("heading", cell) : cell;
			});
			result.push(cells.join("  "));
		} else {
			result.push(line);
		}
	}
	return result;
}
