const DIRECTIVE = /:(pi|codex)-annotation\{index="([1-9]\d*)"\}/g;

interface FenceState {
	fenced: boolean;
	marker: "```" | "~~~" | undefined;
}
export type AnnotationDirectiveRenderer = (index: number, url: string) => string;

export function projectAnnotationDirectives(
	markdown: string,
	annotationCount: number,
	groupKey = "current",
	renderer?: AnnotationDirectiveRenderer,
): string {
	const state: FenceState = { fenced: false, marker: undefined };
	return markdown
		.split("\n")
		.map((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
				const marker = trimmed.startsWith("```") ? "```" : "~~~";
				if (!state.fenced) {
					state.fenced = true;
					state.marker = marker;
				} else if (state.marker === marker) {
					state.fenced = false;
					state.marker = undefined;
				}
				return line;
			}
			if (state.fenced) return line;
			return replaceOutsideInlineCode(line, annotationCount, groupKey, renderer);
		})
		.join("\n");
}

function replaceOutsideInlineCode(
	line: string,
	annotationCount: number,
	groupKey: string,
	renderer?: AnnotationDirectiveRenderer,
): string {
	const parts = line.split(/(`+[^`]*`+)/g);
	return parts
		.map((part, index) =>
			index % 2 === 1
				? part
				: part.replace(DIRECTIVE, (source, _name: string, raw: string) => {
						const value = Number.parseInt(raw, 10);
						if (value > annotationCount) return source;
						const url = `pi-annotation://show/${encodeURIComponent(groupKey)}/${value}`;
						return renderer ? renderer(value, url) : `[${value}]`;
					}),
		)
		.join("");
}
