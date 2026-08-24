import type { DraftAnnotation, ParsedResponseAnnotations, ResponseAnnotation } from "./types.ts";

const HEADER = "# Response annotations:";
const DESCRIPTION = "Each item contains text selected from an earlier response and may include a user comment.";
const OPEN = "<response-annotations>";
const CLOSE = "</response-annotations>";
const REQUEST = "## My request:";

export function annotationText(draft: DraftAnnotation): string {
	return draft.content;
}

export function responseAnnotations(drafts: readonly DraftAnnotation[]): ResponseAnnotation[] {
	return drafts.map((draft) => ({ text: draft.selection.text, annotation: annotationText(draft) }));
}

export function serializeEnvelope(drafts: readonly DraftAnnotation[], ordinaryRequest: string): string {
	return `${HEADER}\n${DESCRIPTION}\n${OPEN}\n${JSON.stringify(responseAnnotations(drafts), null, 2)}\n${CLOSE}\n\n${REQUEST}\n${ordinaryRequest}`;
}

export function parseEnvelope(text: string): ParsedResponseAnnotations | undefined {
	if (!text.startsWith(`${HEADER}\n${DESCRIPTION}\n${OPEN}\n`)) return undefined;
	const requestHeader = `\n${CLOSE}\n\n${REQUEST}`;
	const close = text.indexOf(requestHeader);
	if (close < 0) return undefined;
	const requestBoundary = close + requestHeader.length;
	if (requestBoundary < text.length && text[requestBoundary] !== "\n") return undefined;
	const jsonStart = `${HEADER}\n${DESCRIPTION}\n${OPEN}\n`.length;
	try {
		const parsed: unknown = JSON.parse(text.slice(jsonStart, close));
		if (!Array.isArray(parsed)) return undefined;
		const annotations: ResponseAnnotation[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") return undefined;
			const candidate = item as Partial<ResponseAnnotation>;
			if (typeof candidate.text !== "string" || typeof candidate.annotation !== "string") return undefined;
			annotations.push({ text: candidate.text, annotation: candidate.annotation });
		}
		const requestStart = requestBoundary + (text[requestBoundary] === "\n" ? 1 : 0);
		return { annotations, request: text.slice(requestStart) };
	} catch {
		return undefined;
	}
}

export type AnnotationHeaderRenderer = (annotation: ResponseAnnotation, index: number) => string;

export function projectEnvelope(
	text: string,
	renderHeader?: AnnotationHeaderRenderer,
	projectRequest: (request: string) => string = (request) => request,
): string {
	const parsed = parseEnvelope(text);
	if (!parsed) return text;
	const blocks = parsed.annotations.map((annotation, offset) => {
		const header = renderHeader?.(annotation, offset + 1);
		return `${header ?? `[annotation #${offset + 1}]`}\nSelected text: “${annotation.text}”\nComment: ${legacyAnnotationText(annotation.annotation)}`;
	});
	return [projectRequest(parsed.request), ...blocks].filter((part) => part.length > 0).join("\n\n");
}

/** Read envelopes written before reactions became a creation shortcut. */
export function legacyAnnotationText(text: string): string {
	return text.match(/^Reaction: “(.+)”\nReaction \d+$/s)?.[1] ?? text;
}
