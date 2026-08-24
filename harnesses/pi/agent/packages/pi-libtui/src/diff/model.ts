export type UnifiedDiffLineKind = "context" | "added" | "removed" | "metadata" | "malformed";

export interface UnifiedDiffLine {
	/** Stable within a parsed model and suitable for renderer/highlighter caches. */
	readonly ref: string;
	readonly kind: UnifiedDiffLineKind;
	readonly text: string;
	readonly oldLine?: number;
	readonly newLine?: number;
}

export interface UnifiedDiffHunk {
	readonly ref: string;
	readonly header: string;
	readonly oldStart?: number;
	readonly oldCount?: number;
	readonly newStart?: number;
	readonly newCount?: number;
	readonly lines: readonly UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
	readonly ref: string;
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly headerLines: readonly string[];
	readonly hunks: readonly UnifiedDiffHunk[];
	readonly additions: number;
	readonly removals: number;
}

export interface UnifiedDiffModel {
	readonly revision: string;
	readonly files: readonly UnifiedDiffFile[];
	readonly preamble: readonly string[];
	readonly additions: number;
	readonly removals: number;
	readonly sourceRows: number;
	readonly truncated: boolean;
}

export interface ParseUnifiedDiffOptions {
	/** Hard input limit. Parsing stops before allocating rows beyond this boundary. */
	readonly maxCharacters?: number;
	/** Hard logical-row limit, including file headers. */
	readonly maxRows?: number;
}

export interface UnifiedDiffRowInput {
	readonly kind: UnifiedDiffLineKind;
	readonly text: string;
	readonly oldLine?: number;
	readonly newLine?: number;
}

export interface UnifiedDiffHunkInput {
	readonly header?: string;
	readonly oldStart?: number;
	readonly oldCount?: number;
	readonly newStart?: number;
	readonly newCount?: number;
	readonly rows: readonly UnifiedDiffRowInput[];
}

export interface UnifiedDiffFileInput {
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly headerLines?: readonly string[];
	readonly hunks: readonly UnifiedDiffHunkInput[];
}

export interface CreateUnifiedDiffModelOptions extends ParseUnifiedDiffOptions {
	readonly revision?: string;
	/** Caller-owned truncation performed before the structured model was built. */
	readonly truncated?: boolean;
}
