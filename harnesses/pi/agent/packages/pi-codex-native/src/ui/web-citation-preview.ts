import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { mountHoverPreview, renderDetailCard, type HoverPreviewTarget } from "@luan.sh/pi-libtui";
import { ensureMouseRegistry } from "@luan.sh/pi-libtui/mouse";

export interface WebCitationSource {
	readonly title: string;
	readonly url: string;
	readonly preview: string;
}

const CLOSE = "\x1b]pi-citation:\x07";
const MARKER = /\x1b\]pi-citation:([^\x07\x1b]*)\x07/g;

interface CitationSpan {
	readonly id: string;
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

function citationSpans(screen: readonly string[]): CitationSpan[] {
	const spans: CitationSpan[] = [];
	let id: string | undefined;
	let pending: CitationSpan[] = [];
	for (const [row, line] of screen.entries()) {
		let start = 0;
		for (const marker of line.matchAll(MARKER)) {
			if (id && marker.index > start) pending.push({ id, row, start, end: marker.index });
			if (!marker[1]) {
				spans.push(...pending);
				id = undefined;
			} else {
				try {
					id = decodeURIComponent(marker[1]);
				} catch {
					id = undefined;
				}
			}
			pending = [];
			start = marker.index + marker[0].length;
		}
		// Native wrapping can split CJK titles; each visible fragment is a hover target.
		if (id && start < line.length) pending.push({ id, row, start, end: line.length });
	}
	return spans;
}

export function webCitationMarker(pill: string, id: string): string {
	// Inert identity only; the shared pill keeps label and hyperlink metadata literal.
	return `\x1b]pi-citation:${encodeURIComponent(id)}\x07${pill}${CLOSE}`;
}

export function webCitationTargets(screen: readonly string[]): HoverPreviewTarget[] {
	return citationSpans(screen).flatMap((span) => {
		const line = screen[span.row]!;
		const width = visibleWidth(stripTerminalSequences(line.slice(span.start, span.end)).trimEnd());
		return width
			? [{ id: span.id, rect: { x: visibleWidth(line.slice(0, span.start)), y: span.row, width, height: 1 } }]
			: [];
	});
}

export function installWebCitationPreviews(
	tui: TUI,
	sources: ReadonlyMap<string, WebCitationSource>,
	getTheme: () => Theme,
): () => void {
	const registry = ensureMouseRegistry();
	return mountHoverPreview({
		id: "pi-codex-native.web-citations",
		tui,
		registry,
		getTargets: (screen) => webCitationTargets(screen).filter((target) => sources.has(target.id)),
		async load(target, size) {
			const source = sources.get(target.id);
			if (!source) throw new Error("Source is no longer on this branch");
			const card = renderDetailCard(
				getTheme(),
				{
					title: source.title,
					rows: [source.url, "", source.preview || "No excerpt was returned for this source."],
				},
				size.width,
			);
			const fitted = card.length <= size.height ? card : [...card.slice(0, Math.max(0, size.height - 1)), card.at(-1)!];
			return new Text(fitted.join("\n"), 0, 0);
		},
	});
}
