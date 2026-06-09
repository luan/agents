/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 */

/** File-section header delimiters: `[path#tag]`. */
export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";

/** Payload sigil for literal body rows. */
export const HL_PAYLOAD_REPLACE = "+";

/** Hunk-header keyword for concrete line replacement. */
export const HL_REPLACE_KEYWORD = "replace";
/** Hunk-header sub-keyword: `replace block N:` resolves N to a tree-sitter block range. */
export const HL_BLOCK_KEYWORD = "block";
/** Hunk-header keyword for concrete line deletion. */
export const HL_DELETE_KEYWORD = "delete";
/** Hunk-header keyword for insertion operations. */
export const HL_INSERT_KEYWORD = "insert";
/** Insert position keyword for inserting before a concrete line. */
export const HL_INSERT_BEFORE = "before";
/** Insert position keyword for inserting after a concrete line. */
export const HL_INSERT_AFTER = "after";
/** Insert position keyword for inserting at the start of the file. */
export const HL_INSERT_HEAD = "head";
/** Insert position keyword for inserting at the end of the file. */
export const HL_INSERT_TAIL = "tail";
/** Hunk-header terminator for body-bearing operations. */
export const HL_HEADER_COLON = ":";

/** Separator between a hashline file path and its opaque snapshot tag. */
export const HL_FILE_HASH_SEP = "#";

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":";

/** Number of hex characters in an opaque snapshot tag. */
export const HL_FILE_HASH_LENGTH = 4;

/**
 * Representative snapshot tags for use in user-facing error messages and
 * prompt examples.
 */
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const;

/** Format a hashline section header for a file path and snapshot tag. */
export function formatHashlineHeader(filePath: string, fileHash: string): string {
	return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}

/** Formats a single numbered line as `LINE:TEXT`. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/** Format file text with hashline-mode line-number prefixes for display. */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n");
}
