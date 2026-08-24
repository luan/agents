import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const MARKER_SEQUENCE = /\x1b_pi-annotation:([^\x07\x1b]*)\x07/g;
const MARKER_PREFIX = "pi-annotation:";
const MARKER_CLOSE = "\x1b_pi-annotation:\x07";

export function renderAnnotationMarker(text: string, url: string): string {
	// This marker is inserted before Pi parses Markdown. APC is zero-width and
	// carries identity for the screen decorator without enabling terminal links.
	if (
		text.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b") ||
		url.includes("\x1b") ||
		url.includes("\n") ||
		!url.startsWith("pi-annotation://")
	) {
		throw new TypeError("Invalid annotation marker");
	}
	return `\x1b_${MARKER_PREFIX}${encodeURIComponent(url)}\x07${text}${MARKER_CLOSE}`;
}

export function stripAnnotationMarker(line: string): string {
	return line.replace(MARKER_SEQUENCE, "").replaceAll(MARKER_CLOSE, "");
}

export interface AnnotationPointMarker {
	url: string;
	row: number;
	col: number;
	width: number;
}

export function findAnnotationPointMarkers(lines: readonly string[]): AnnotationPointMarker[] {
	const markers: AnnotationPointMarker[] = [];
	for (const [row, line] of lines.entries()) {
		for (const match of line.matchAll(MARKER_SEQUENCE)) {
			const encodedUrl = match[1];
			// The closing APC has the same prefix but no URL. It is not a point
			// marker and must not become a second hit at the end of the pill.
			if (!encodedUrl) continue;
			const url = decodeURIComponent(encodedUrl);
			const start = match.index ?? 0;
			const contentStart = start + match[0].length;
			const contentEnd = line.indexOf(MARKER_CLOSE, contentStart);
			// Native selection can split an APC wrapper and leave a dangling
			// opener. It carries no reliable visible span, so ignore it instead
			// of measuring the rest of the line as pill content.
			if (contentEnd < 0) continue;
			const content = line.slice(contentStart, contentEnd);
			markers.push({
				url,
				row,
				col: visibleWidth(stripTerminalSequences(line.slice(0, start))),
				width: visibleWidth(stripTerminalSequences(content)),
			});
		}
	}
	return markers;
}

/** Replace one inert annotation marker and its visible pill. */
export function replaceAnnotationMarker(line: string, url: string, replacement: string): string {
	const marker = `\x1b_${MARKER_PREFIX}${encodeURIComponent(url)}\x07`;
	const startIndex = line.indexOf(marker);
	if (startIndex < 0) return line;
	const endIndex = line.indexOf(MARKER_CLOSE, startIndex + marker.length);
	if (endIndex < 0) return line;
	return `${line.slice(0, startIndex)}${replacement}${line.slice(endIndex + MARKER_CLOSE.length)}`;
}
