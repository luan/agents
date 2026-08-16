import { approxTokenCount, bytesPerTokenOf, capMiddleByBytes } from "./output-budget.ts";

export const DEFAULT_TOOL_TOKEN_BUDGET = 6_000;
// A ceiling a caller can raise without limit is not a ceiling, so 25,000 caps even an explicit request.
export const HARD_MAX_TOOL_TOKENS = 25_000;

// Calibrated against 119k observed results: each budget sits above that tool's p90. Re-verified in real tokens over
// 127,213 recorded results (2.77GB of ~/.pi/agent/sessions): every row still clears its p90, from 1.23x on `exec` to
// 34x on `write`, so making the estimator exact retuned no constant here.
export const TOOL_TOKEN_BUDGETS: Record<string, number> = {
	exec_command: 2_500,
	write_stdin: 2_500,
	read: 6_000,
	search: 4_000,
	find: 3_000,
	edit: 1_000,
	write: 1_000,
	apply_patch: 1_000,
	ast_edit: 1_000,
	exec: 6_000,
	wait: 6_000,
};

export function resolveToolBudget(toolName: string | undefined, requestedTokens?: number): number {
	const requested = Number.isFinite(requestedTokens) ? (requestedTokens as number) : undefined;
	const configured = toolName ? TOOL_TOKEN_BUDGETS[toolName] : undefined;
	const budget = requested ?? configured ?? DEFAULT_TOOL_TOKEN_BUDGET;
	return Math.min(Math.max(1, Math.floor(budget)), HARD_MAX_TOOL_TOKENS);
}

export type ArtifactMinter = (
	text: string,
	label: string,
	existingUri?: string,
	ownerSessionId?: string,
) => Promise<string | undefined>;

// Extension loaders isolate module state, so share the minter through globalThis.
const ARTIFACT_MINTER = Symbol.for("agents.artifactMinter");
const minterState = globalThis as typeof globalThis & Record<symbol, { mint?: ArtifactMinter } | undefined>;
const minterSlot = minterState[ARTIFACT_MINTER] ?? {};
minterState[ARTIFACT_MINTER] = minterSlot;

export function setArtifactMinter(minter: ArtifactMinter | undefined): void {
	minterSlot.mint = minter;
}

export function hasArtifactMinter(): boolean {
	return minterSlot.mint !== undefined;
}

/**
 * Mint an artifact, or replace `existingUri` in place, returning its URI.
 *
 * Never throws and never rejects: every caller is midway through returning a result, so a broken store costs the
 * recovery pointer and nothing else.
 */
export async function mintQuietly(
	text: string,
	label: string,
	existingUri?: string,
	ownerSessionId?: string,
): Promise<string | undefined> {
	const mint = minterSlot.mint;
	if (!mint) return undefined;
	try {
		return await mint(text, label, existingUri, ownerSessionId);
	} catch {
		return undefined;
	}
}

export interface BoundedText {
	text: string;
	truncated: boolean;
	originalTokens: number;
	originalLines: number;
	artifactUri?: string;
}

const HEAD_SHARE = 0.6;

// A line cannot fit if even its cheapest possible tokenisation exceeds what is left, and 5.49 was the highest
// bytes-per-token measured over 35 tool outputs, so 6 rejects a monster line without tokenising it.
const MAX_BYTES_PER_TOKEN = 6;

const NOTICE_TOKEN_RESERVE = 64;

function contentBudget(maxTokens: number): number {
	const reserve = Math.min(NOTICE_TOKEN_RESERVE, Math.floor(maxTokens / 2));
	return Math.max(1, maxTokens - reserve);
}

function countLines(text: string): number {
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
	return lines;
}

function elisionNotice(options: {
	omittedLines: number;
	originalLines: number;
	omittedTokens: number;
	originalTokens: number;
	fullOutputRef?: string;
	contentLabel?: string;
}): string {
	const scope =
		options.omittedLines > 0
			? `elided ${options.omittedLines} of ${options.originalLines} lines and ~${options.omittedTokens} of ~${options.originalTokens} tokens${options.contentLabel ? ` from ${options.contentLabel}` : ""}`
			: `elided ~${options.omittedTokens} of ~${options.originalTokens} tokens${options.contentLabel ? ` from ${options.contentLabel}` : ""}; no complete line fit the budget`;
	const recovery = options.fullOutputRef
		? `Full output: ${options.fullOutputRef}`
		: "Not recoverable — narrow the call to see the omitted range.";
	return `[… ${scope}. ${recovery} …]`;
}

export interface TruncateOptions {
	fullOutputRef?: string;
	contentLabel?: string;
}

// Head and tail are filled by real per-line token cost, not by bytes. Sizing them at a flat 4 bytes per token is what
// let `truncated: true` still breach the budget: `read` shipped 8,823 real tokens against 6,000, `exec_command` 4,348
// against 2,500. Cost: 4.08ms for 2,000 lines, and the per-line sum matched the whole-text count to 0.0%.
export function truncateMiddleByTokens(text: string, maxTokens: number, options: TruncateOptions = {}): BoundedText {
	const originalTokens = approxTokenCount(text);
	const budget = contentBudget(maxTokens);
	if (originalTokens <= budget) {
		return { text, truncated: false, originalTokens, originalLines: countLines(text) };
	}

	const originalLines = countLines(text);
	const headBudget = Math.max(1, Math.floor(budget * HEAD_SHARE));
	const tailBudget = Math.max(1, budget - Math.floor(budget * HEAD_SHARE));

	let headLines = 0;
	let headTokens = 0;
	let headEnd = 0;
	let cursor = 0;
	for (let remaining = originalLines; remaining > 0; remaining--) {
		const newline = text.indexOf("\n", cursor);
		const lineEnd = newline === -1 ? text.length : newline;
		if (lineEnd - cursor + 1 > (headBudget - headTokens) * MAX_BYTES_PER_TOKEN) break;
		const cost = approxTokenCount(`${text.slice(cursor, lineEnd)}\n`);
		if (headTokens + cost > headBudget) break;
		headTokens += cost;
		headLines++;
		headEnd = lineEnd;
		cursor = lineEnd + 1;
	}

	const bodyStart = headLines > 0 ? headEnd + 1 : 0;
	let tailLines = 0;
	let tailTokens = 0;
	let tailStart = text.length;
	let lineEnd = text.length;
	while (tailLines < originalLines - headLines && lineEnd >= 0) {
		const newline = lineEnd > 0 ? text.lastIndexOf("\n", lineEnd - 1) : -1;
		const lineStart = newline === -1 ? 0 : newline + 1;
		if (lineStart < bodyStart) break;
		if (lineEnd - lineStart + 1 > (tailBudget - tailTokens) * MAX_BYTES_PER_TOKEN) break;
		const cost = approxTokenCount(`${text.slice(lineStart, lineEnd)}\n`);
		if (tailTokens + cost > tailBudget) break;
		tailTokens += cost;
		tailLines++;
		tailStart = lineStart;
		lineEnd = lineStart - 1;
	}

	const keptTokens = headTokens + tailTokens;
	const omittedTokens = Math.max(0, originalTokens - keptTokens);

	if (headLines === 0 && tailLines === 0) {
		// No whole line fit, so cap by bytes sized from this text's own density rather than a flat 4 bytes per token.
		const capped = capMiddleByBytes(text, Math.max(1, Math.floor(budget * bytesPerTokenOf(text))), {
			headShare: HEAD_SHARE,
			notice: (omittedBytes) =>
				`\n${elisionNotice({
					omittedLines: 0,
					originalLines,
					omittedTokens: Math.ceil(omittedBytes / bytesPerTokenOf(text)),
					originalTokens,
					fullOutputRef: options.fullOutputRef,
					contentLabel: options.contentLabel,
				})}\n`,
		});
		return { text: capped, truncated: true, originalTokens, originalLines };
	}

	const notice = elisionNotice({
		omittedLines: originalLines - headLines - tailLines,
		originalLines,
		omittedTokens,
		originalTokens,
		fullOutputRef: options.fullOutputRef,
		contentLabel: options.contentLabel,
	});
	const parts: string[] = [];
	if (headLines > 0) parts.push(text.slice(0, headEnd));
	parts.push(notice);
	if (tailLines > 0) parts.push(text.slice(tailStart));
	return { text: parts.join("\n"), truncated: true, originalTokens, originalLines };
}

export interface BoundTextOptions {
	maxTokens: number;
	label: string;
	contentLabel?: string;
	artifactUri?: string;
	artifactText?: string;
	ownerSessionId?: string;
}

// capture.ts:85 and output-budget.ts:206 emit different recovery notices. Match both forms, but not arbitrary artifact mentions.
const EXISTING_CAPTURE_REF =
	/(?:Full output: (artifact:\/\/[A-Za-z0-9._-]+)|Read (artifact:\/\/[A-Za-z0-9._-]+) for the full output\.)/;

// Mint first so the notice can include the URI; store failure only loses the pointer.
export async function boundTextWithArtifact(text: string, options: BoundTextOptions): Promise<BoundedText> {
	const originalTokens = approxTokenCount(text);
	const artifactText = options.artifactText ?? text;
	if (options.artifactUri && options.artifactText !== undefined) {
		await mintQuietly(artifactText, options.label, options.artifactUri, options.ownerSessionId);
	}
	if (originalTokens <= contentBudget(options.maxTokens)) {
		return {
			text,
			truncated: false,
			originalTokens,
			originalLines: countLines(text),
			artifactUri: options.artifactUri,
		};
	}
	const existingMatch = EXISTING_CAPTURE_REF.exec(text);
	const existing = existingMatch?.[1] ?? existingMatch?.[2];
	const uri =
		options.artifactUri ??
		existing ??
		(await mintQuietly(artifactText, options.label, undefined, options.ownerSessionId));
	const bounded = truncateMiddleByTokens(text, options.maxTokens, {
		fullOutputRef: uri,
		contentLabel: options.contentLabel,
	});
	return { ...bounded, artifactUri: uri };
}

export interface BoundableToolResultEvent {
	toolName?: unknown;
	input?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: unknown;
	ownerSessionId?: string;
}

function requestedBudget(input: unknown): number | undefined {
	const requested = (input as { max_output_tokens?: unknown })?.max_output_tokens;
	return typeof requested === "number" && Number.isFinite(requested) ? requested : undefined;
}

export interface ToolResultPatch {
	content?: unknown[];
	details?: unknown;
	isError?: boolean;
}

interface TextBlock {
	type: "text";
	text: string;
	[key: string]: unknown;
}

function isTextBlock(item: unknown): item is TextBlock {
	return (
		!!item &&
		typeof item === "object" &&
		"type" in item &&
		(item as { type: unknown }).type === "text" &&
		"text" in item &&
		typeof (item as { text: unknown }).text === "string"
	);
}

export async function boundToolResultEvent(event: BoundableToolResultEvent): Promise<ToolResultPatch | undefined> {
	if (!Array.isArray(event.content)) return undefined;
	const textBlocks = event.content.filter(isTextBlock);
	if (textBlocks.length === 0) return undefined;

	const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
	const budget = resolveToolBudget(toolName, requestedBudget(event.input));
	const combined = textBlocks.map((item) => item.text).join("\n");
	const bounded = await boundTextWithArtifact(combined, {
		maxTokens: budget,
		label: `${toolName ?? "tool"} result`,
		contentLabel: textBlocks.length > 1 ? `${textBlocks.length} text blocks` : undefined,
		ownerSessionId: event.ownerSessionId,
	});
	if (!bounded.truncated) return undefined;

	const next: unknown[] = [];
	let inserted = false;
	for (const item of event.content) {
		if (!isTextBlock(item)) {
			next.push(item);
			continue;
		}
		if (inserted) continue;
		next.push({ ...item, text: bounded.text });
		inserted = true;
	}
	const details =
		event.details &&
		typeof event.details === "object" &&
		!Array.isArray(event.details) &&
		"outputTokens" in event.details
			? {
					...(event.details as Record<string, unknown>),
					outputTokens: approxTokenCount(bounded.text),
					outputBounded: true,
				}
			: undefined;
	return { content: next, ...(details ? { details } : {}) };
}
