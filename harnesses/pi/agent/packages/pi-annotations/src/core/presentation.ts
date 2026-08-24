import { projectAnnotationDirectives, type AnnotationDirectiveRenderer } from "./directives.ts";
import { parseEnvelope, projectEnvelope, type AnnotationHeaderRenderer } from "./envelope.ts";
import type { ResponseAnnotation } from "./types.ts";

export interface ResolvedAnnotationLink {
	annotation: ResponseAnnotation;
	index: number;
	surface: "base" | "user";
}

export class AnnotationPresentationGroups {
	private current: ResponseAnnotation[] = [];
	private currentKey = "none";
	private readonly groups = new Map<string, ResponseAnnotation[]>();

	clear(): void {
		this.current = [];
		this.currentKey = "none";
		this.groups.clear();
	}

	projectUser(
		markdown: string,
		renderHeader?: AnnotationHeaderRenderer,
		renderReference?: (annotation: ResponseAnnotation, index: number, url: string) => string,
	): string {
		const parsed = parseEnvelope(markdown);
		// Ordinary user turns do not replace the active annotation envelope. Pi may
		// render those turns between an annotated request and its assistant reply.
		if (parsed) {
			this.current = parsed.annotations;
			this.currentKey = envelopeKey(markdown);
			this.groups.set(this.currentKey, parsed.annotations);
		}
		return projectEnvelope(markdown, renderHeader, (request) =>
			this.projectReferences(request, renderReference, "user"),
		);
	}

	projectAssistant(
		markdown: string,
		renderer?: (annotation: ResponseAnnotation, index: number, url: string) => string,
	): string {
		return this.projectReferences(markdown, renderer, "base");
	}

	resolve(url: string): ResolvedAnnotationLink | undefined {
		const match = url.match(/^pi-annotation:\/\/show\/([^/]+)\/([1-9]\d*)(\?surface=user)?$/);
		if (!match) return undefined;
		const group = this.groups.get(decodeURIComponent(match[1]!));
		const index = Number.parseInt(match[2]!, 10);
		const annotation = group?.[index - 1];
		return annotation ? { annotation, index, surface: match[3] ? "user" : "base" } : undefined;
	}

	referenceUrl(index: number, surface: "user" | "base"): string {
		return `pi-annotation://show/${encodeURIComponent(this.currentKey)}/${index}${surface === "user" ? "?surface=user" : ""}`;
	}

	private projectReferences(
		markdown: string,
		renderer: ((annotation: ResponseAnnotation, index: number, url: string) => string) | undefined,
		surface: "base" | "user",
	): string {
		const directiveRenderer: AnnotationDirectiveRenderer | undefined = renderer
			? (index, url) => renderer(this.current[index - 1]!, index, surface === "user" ? `${url}?surface=user` : url)
			: undefined;
		return projectAnnotationDirectives(markdown, this.current.length, this.currentKey, directiveRenderer);
	}
}

function envelopeKey(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}
