/**
 * Expand deferred block edits (`replace block N:` / `delete block N` /
 * `insert after block N:`) into concrete inserts + deletes.
 *
 * The hashline parser cannot expand a block edit on its own — the line span is
 * unknown until file text + path (→ language) are available. This transform
 * runs at every apply/preview boundary that has text: it calls the injected
 * {@link BlockResolver} to resolve each block's `[start, end]` span, then emits
 * the exact same edits the concrete form produces in the parser: `replace
 * start..end:` inserts + deletes for a replace, a pure range delete for a
 * delete, and plain `after_anchor` inserts at `end` for an insert-after. After
 * it runs, no `block` edits remain, so {@link applyEdits} (and recovery) only
 * ever see resolved edits.
 */
import { STRUCTURAL_CLOSER_RE } from "./apply";
import {
	blockResolverFailureMessage,
	blockSingleLineMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
} from "./messages";
import type {
	BlockResolution,
	BlockResolver,
	BlockResolverFailure,
	BlockResolverResult,
	BlockSpan,
	Cursor,
	Edit,
} from "./types";

export interface ResolveBlockEditsOptions {
	/**
	 * How to handle a block edit that cannot be resolved safely. `"throw"`
	 * (default) raises a diagnostic error — used by the authoritative apply +
	 * final preview paths. `"drop"` silently skips the edit — used by the
	 * streaming preview, where a half-written file or transient parse error must
	 * not throw. `insert after block N:` only lowers to plain `insert after N:`
	 * for no-block/closer cases; syntax, parser, and language failures reject.
	 */
	onUnresolved?: "throw" | "drop";
	/**
	 * Invoked once per successfully resolved block edit, in patch order, with
	 * the anchor line and the concrete span it resolved to. Lets the host echo
	 * the resolution back to the caller. Never fired for dropped/unresolvable
	 * edits.
	 */
	onResolved?: (resolution: BlockResolution) => void;
	/**
	 * Invoked once per diagnostic produced while resolving — currently the safe
	 * `insert after block N:` lowerings (closer/no-block cases). Hosts should
	 * surface these on the apply result's `warnings`.
	 */
	onWarning?: (message: string) => void;
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some((edit) => edit.kind === "block");
}

function isBlockResolverFailure(result: BlockResolverResult): result is BlockResolverFailure {
	return result !== null && "reason" in result;
}

function resolveBlock(
	resolver: BlockResolver | undefined,
	request: Parameters<BlockResolver>[0],
): BlockSpan | BlockResolverFailure {
	if (!resolver) return { reason: "parser_unavailable" };
	return resolver(request) ?? { reason: "no_block" };
}

function lowerInsertAfterBlock(
	edit: Extract<Edit, { kind: "block" }>,
	resolved: Edit[],
	text: string,
	synthIndex: number,
	onWarning: ((message: string) => void) | undefined,
): number {
	const anchorText = text.split("\n")[edit.anchor.line - 1];
	const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
	onWarning?.(
		isCloser
			? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
			: insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
	);
	for (const payload of edit.payloads) {
		const cursor: Cursor = { kind: "after_anchor", anchor: { line: edit.anchor.line } };
		resolved.push({ kind: "insert", cursor, text: payload, lineNum: edit.lineNum, index: synthIndex++ });
	}
	return synthIndex;
}
/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
	edits: readonly Edit[],
	text: string,
	path: string,
	resolver: BlockResolver | undefined,
	options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
	if (!hasBlockEdit(edits)) return edits;
	const onUnresolved = options.onUnresolved ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const op = edit.mode === "insert_after" ? "insert_after" : edit.payloads.length === 0 ? "delete" : "replace";
		const span = resolveBlock(resolver, { path, text, line: edit.anchor.line });
		if (isBlockResolverFailure(span)) {
			if (onUnresolved === "drop") continue;
			if (op === "insert_after" && span.reason === "no_block") {
				synthIndex = lowerInsertAfterBlock(edit, resolved, text, synthIndex, options.onWarning);
				continue;
			}
			throw new Error(`line ${edit.lineNum}: ${blockResolverFailureMessage(edit.anchor.line, op, span.reason)}`);
		}
		if (span.start === span.end) {
			if (onUnresolved === "drop") continue;
			throw new Error(`line ${edit.lineNum}: ${blockSingleLineMessage(edit.anchor.line, op)}`);
		}
		options.onResolved?.({
			anchorLine: edit.anchor.line,
			start: span.start,
			end: span.end,
			op,
		});
		if (op === "insert_after") {
			for (const payload of edit.payloads) {
				const cursor: Cursor = { kind: "after_anchor", anchor: { line: span.end } };
				resolved.push({
					kind: "insert",
					cursor,
					text: payload,
					lineNum: edit.lineNum,
					index: synthIndex++,
					blockStart: span.start,
				});
			}
			continue;
		}
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
			resolved.push({
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: synthIndex++,
				mode: "replacement",
			});
		}
		for (let line = span.start; line <= span.end; line++) {
			resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ });
		}
	}
	return resolved;
}
