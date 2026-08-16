/**
 * Pure data types shared across the hashline parser, applier, and patcher.
 * Nothing in this file references a filesystem, agent runtime, or schema
 * library — keep it that way.
 */

/** A line-number anchor (1-indexed). */
export interface Anchor {
	line: number;
	/** Optional per-line hash copied from a read row. */
	hash?: string;
	/** Optional exact row content copied from a read row. */
	content?: string;
}

/** Where an `insert` edit should land relative to existing content. */
export type Cursor =
	| { kind: "bof" }
	| { kind: "eof" }
	| { kind: "before_anchor"; anchor: Anchor }
	| { kind: "after_anchor"; anchor: Anchor };

/**
 * A single low-level edit produced by the parser and consumed by the applier.
 * Multi-line replacements decompose to one `insert` per replacement line plus
 * one `delete` per consumed line. Replacement payloads are tagged so the
 * applier can distinguish literal insertion from new content for a deleted
 * line.
 */
export type Edit =
	| {
			kind: "insert";
			cursor: Cursor;
			text: string;
			lineNum: number;
			index: number;
			mode?: "replacement";
			/**
			 * Present on inserts lowered from `PUT >N*:`: the
			 * resolved block's first line. Lets the applier slide a body that
			 * claims a depth inside the block back across the block's trailing
			 * closer lines (never above this line).
			 */
			blockStart?: number;
	  }
	| { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string }
	| {
			/**
			 * Clipboard cut (`CUT N-M @r`, or the resolved form of `CUT N* @r`).
			 * Captures the range's current lines into a {@link Clipboard}
			 * register during the applier's clipboard pre-pass and lowers to one
			 * `delete` per range line at parse/resolve time. `register` names the
			 * target slot; absent means the batch-local anonymous register.
			 */
			kind: "cut";
			range: ParsedRange;
			register?: string;
			lineNum: number;
			index: number;
	  }
	| {
			/**
			 * Clipboard insertion or replacement (`PUT <N @r` / `PUT >N @r` /
			 * `PUT N-M @r`, their `>N*` block-resolved forms, or the register-less
			 * anonymous equivalents). Expanded by the clipboard pre-pass into one
			 * plain insert per captured line; `span` targets additionally expand
			 * into per-line deletes there — only after the register read
			 * succeeds, so a dropped paste (streaming preview with an empty
			 * register) never leaves destructive orphan deletes. `blockStart`
			 * mirrors the insert variant's field for block-lowered gap pastes so
			 * landing correction can slide the body across trailing closer lines.
			 */
			kind: "paste";
			at: PasteTarget;
			register?: string;
			lineNum: number;
			index: number;
			blockStart?: number;
	  }
	| {
			/**
			 * Deferred block edit (`PUT N*:`, `PUT >N*:`, `CUT N*`, or their
			 * `@register` forms). The exact line span is unknown at parse time;
			 * {@link resolveBlockEdits} computes it once file text and language
			 * are available, then expands it into concrete edits.
			 * `mode: "insert_after"` becomes plain `after_anchor` inserts,
			 * `"cut"` becomes a clipboard cut plus per-line deletes, and
			 * `"paste_after"` becomes a gap paste after the resolved block. No
			 * mode denotes a block replacement — from body payloads, or from
			 * `register` when one is named (a span paste over the resolved block).
			 */
			kind: "block";
			anchor: Anchor;
			payloads: string[];
			mode?: "insert_after" | "cut" | "paste_after";
			register?: string;
			lineNum: number;
			index: number;
	  };

/** Where a `paste` edit lands: an insertion gap, or a span it replaces. */
export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

/** File-level operation parsed from a section body (`REM` / `MV`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Result of applying a parsed set of edits to a text body. */
export interface ApplyResult {
	/** Post-edit text body. */
	text: string;
	/** First line number (1-indexed) that changed, or `undefined` for a no-op apply. */
	firstChangedLine?: number;
	/** Diagnostic warnings collected by the parser, patcher, or recovery. */
	warnings?: string[];
	/**
	 * Resolved spans for each block op in this apply, in patch order. Present
	 * only when the apply matched the tagged content, so the line numbers match
	 * what the caller read. Absent when there were no block ops.
	 */
	blockResolutions?: BlockResolution[];
}

/** Local host behavior retained around the OMP applier. */
export interface ApplyOptions {
	autoDropPureInsertDuplicates?: boolean;
	clipboard?: Clipboard;
	onEmptyPaste?: "throw" | "drop";
	path?: string;
	syntaxValidator?: SyntaxValidator;
}

export type SyntaxValidationResult =
	| { kind: "valid"; errorCount: 0 }
	| { kind: "invalid"; errorCount: number; detail?: string }
	| { kind: "unsupported_language" }
	| { kind: "parser_unavailable" };

export type SyntaxValidator = (request: { path: string; text: string }) => SyntaxValidationResult;

/** A parsed `A-B` inclusive line range. */
export interface ParsedRange {
	start: Anchor;
	end: Anchor;
}

/** Optional hints for {@link splitPatchInput}. */
export interface SplitOptions {
	/** Resolves absolute paths inside hashline headers to cwd-relative form. */
	cwd?: string;
	/**
	 * Fallback path used when the input lacks a `[PATH]` header but contains
	 * recognizable hashline operations. Lets streaming previews work before
	 * the model has written the header.
	 */
	path?: string;
}

/** Result of {@link buildCompactDiffPreview}. */
export interface CompactDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

/** Optional knobs for {@link buildCompactDiffPreview}. */
export interface CompactDiffOptions {
	/** Added lines kept on each side of a long added-run elision (default 2). */
	maxAddedRunContext?: number;
	/** Back-compat alias for {@link maxAddedRunContext}. */
	maxUnchangedRun?: number;
}

/** Resolved 1-indexed inclusive line span of a block target. */
export interface BlockSpan {
	/** First line of the block (1-indexed, inclusive). */
	start: number;
	/** Last line of the block (1-indexed, inclusive). */
	end: number;
}

/**
 * One block-op anchor resolved to its concrete line span. Surfaced on
 * {@link ApplyResult} so the host can echo the resolved range and let the
 * model catch an anchor on the wrong opener.
 */
export interface BlockResolution {
	/** The 1-indexed line the block op was anchored on (the `N`). */
	anchorLine: number;
	/** First line of the resolved span (1-indexed, inclusive). */
	start: number;
	/** Last line of the resolved span (1-indexed, inclusive). */
	end: number;
	/** Which block op produced this resolution. */
	op: "replace" | "insert_after" | "cut" | "paste_after";
}

/** Request handed to a {@link BlockResolver} to resolve one block-op anchor. */
export interface BlockResolverRequest {
	/** Target file path (used to infer language by extension). */
	path: string;
	/** Full text the block must be resolved against (the snapshot the tag names). */
	text: string;
	/** 1-indexed line the block must begin on. */
	line: number;
}

export type BlockResolverFailureReason = "no_block" | "syntax_error" | "parser_unavailable" | "unsupported_language";

export interface BlockResolverFailure {
	readonly reason: BlockResolverFailureReason;
}

export type BlockResolverResult = BlockSpan | BlockResolverFailure | null;

/** Resolve a block opener, or return a diagnostic failure when the host can identify one. */
export type BlockResolver = (request: BlockResolverRequest) => BlockResolverResult;

/**
 * Mutable clipboard registers threaded through one patch application. Filled
 * by `CUT` edits and read by register `PUT`s in patch source order, across
 * sections, so content can move between files.
 *
 * The anonymous register (`lines`) is batch-local: {@link forkClipboard}
 * never copies it in, so it exists only between a `CUT` and a paste inside
 * one patch. Named registers (`named`) persist across batches when the host
 * owns the Clipboard (`PatcherOptions.clipboard`) — the sanctioned way to
 * move content across separate edit calls.
 */
export interface Clipboard {
	/** Anonymous register: lines captured by the latest unlabeled `CUT` in this batch. */
	lines?: readonly string[];
	/** Named registers captured by `CUT … @name`. */
	named?: Map<string, readonly string[]>;
	/**
	 * Headers of unlabeled `CUT`s seen since the last unlabeled paste in this
	 * batch. Two or more make the next unlabeled paste ambiguous (which cut
	 * did the author mean?) and fail it with a labeling hint.
	 */
	pendingAnonCuts?: string[];
}
