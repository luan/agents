import { renderDiffWithHighlighter, type ThemedDiffResult } from "@pierre/diffs";
import {
	loadedDiffHighlighter,
	type SyntaxHighlightSpan,
	syntaxLanguage,
	syntaxSpansFromPierreLine,
} from "../syntax.ts";
import type { UnifiedDiffModel } from "./model.ts";
import { pierreFilesFor } from "./parse.ts";

/** Syntax spans mapped to stable unified-diff line refs. */
export interface DiffSyntax {
	readonly highlighted: boolean;
	readonly lines: ReadonlyMap<string, readonly SyntaxHighlightSpan[]>;
}

const syntaxCache = new WeakMap<UnifiedDiffModel, ReadonlyMap<string, readonly SyntaxHighlightSpan[]>>();

/** Adapt Pierre's highlighted line nodes to the libtui diff model. */
export function diffSyntax(model: UnifiedDiffModel): DiffSyntax {
	const highlighter = loadedDiffHighlighter();
	const sources = pierreFilesFor(model);
	if (!highlighter || sources.length === 0) return { highlighted: false, lines: new Map() };
	const cached = syntaxCache.get(model);
	if (cached) return { highlighted: true, lines: cached };
	const lines = new Map<string, readonly SyntaxHighlightSpan[]>();
	for (const [fileIndex, file] of model.files.entries()) {
		const source = sources[fileIndex];
		if (!source) continue;
		let result: ThemedDiffResult;
		try {
			result = renderDiffWithHighlighter(
				{ ...source, lang: syntaxLanguage(file.newPath ?? file.oldPath) },
				highlighter,
				{
					theme: "github-dark",
					useTokenTransformer: true,
					tokenizeMaxLineLength: 20_000,
					lineDiffType: "word-alt",
					maxLineDiffLength: 20_000,
				},
			);
		} catch {
			continue;
		}
		const deletionNodes = lineNodesByNumber(result.code.deletionLines);
		const additionNodes = lineNodesByNumber(result.code.additionLines);
		for (const hunk of file.hunks) {
			for (const line of hunk.lines) {
				const sourceNode =
					line.kind === "removed"
						? takeLineNode(deletionNodes, line.oldLine)
						: line.kind === "added" || line.kind === "context"
							? takeLineNode(additionNodes, line.newLine)
							: undefined;
				if (sourceNode) lines.set(line.ref, syntaxSpansFromPierreLine(sourceNode));
			}
		}
	}
	syntaxCache.set(model, lines);
	return { highlighted: true, lines };
}

type PierreLineNode = ThemedDiffResult["code"]["additionLines"][number];

function lineNodesByNumber(nodes: readonly PierreLineNode[]): Map<number, PierreLineNode[]> {
	const indexed = new Map<number, PierreLineNode[]>();
	for (const node of nodes) {
		if (node?.type !== "element") continue;
		const raw = node.properties["data-line"];
		const lineNumber = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
		if (!Number.isFinite(lineNumber)) continue;
		const bucket = indexed.get(lineNumber) ?? [];
		bucket.push(node);
		indexed.set(lineNumber, bucket);
	}
	return indexed;
}

function takeLineNode(
	lines: Map<number, PierreLineNode[]>,
	lineNumber: number | undefined,
): PierreLineNode | undefined {
	if (lineNumber === undefined) return undefined;
	return lines.get(lineNumber)?.shift();
}
