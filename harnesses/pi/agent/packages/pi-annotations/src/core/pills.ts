import { icon, type PillContent, renderPillText } from "pi-libtui";
import { legacyAnnotationText } from "./envelope.ts";
import type { DraftAnnotation, ResponseAnnotation } from "./types.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}]|\uFE0F|\u20E3/u;

export function annotationIcon(content: string): string {
	const first = [...graphemes.segment(content)][0]?.segment;
	return first && emoji.test(first) ? first : icon("comment");
}

function annotationPillContent(content: string, index: number): PillContent {
	return { icon: { glyph: annotationIcon(content) }, label: `#${index}` };
}

export function composerPillContent(draft: DraftAnnotation): PillContent {
	return annotationPillContent(draft.content, draft.index);
}

export function transcriptPillContent(draft: DraftAnnotation): PillContent {
	return annotationPillContent(draft.content, draft.index);
}

export function plainPill(content: PillContent): string {
	return renderPillText(content);
}

export function responsePillContent(annotation: ResponseAnnotation, index: number): PillContent {
	return annotationPillContent(legacyAnnotationText(annotation.annotation), index);
}
