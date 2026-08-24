import type { SelectionPoint, SelectionShape, SelectionSourceAnchor } from "pi-libtui/selection";

export interface AnnotationSelection {
	messageId: string;
	messageIdStability: "stable" | "best-effort";
	text: string;
	shape: SelectionShape;
	start: SelectionPoint;
	end: SelectionPoint;
	screenStart: SelectionPoint;
	screenEnd: SelectionPoint;
	source?: SelectionSourceAnchor;
}

export interface DraftAnnotation {
	id: string;
	index: number;
	token: string;
	selection: AnnotationSelection;
	content: string;
}

export interface ResponseAnnotation {
	text: string;
	annotation: string;
}

export interface ParsedResponseAnnotations {
	annotations: ResponseAnnotation[];
	request: string;
}
