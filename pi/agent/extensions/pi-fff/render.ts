import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { type ExplorationAction, isExplorationHidden, renderExplorationCall } from "../shared/exploration-rendering";

export function getResultText(result: { content?: { type: string; text?: string }[] }): string {
	return result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
}

export function searchAction(query: string, path: string): ExplorationAction {
	return {
		kind: "search",
		title: "Search",
		body: path && path !== "." ? `${query} in ${path}` : query,
	};
}

export function findAction(query: string, path: string): ExplorationAction {
	return {
		kind: "find",
		title: "Find",
		body: path && path !== "." ? `${query} in ${path}` : query,
	};
}

export function renderExploreCall(action: ExplorationAction, theme: any, context: any): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(renderExplorationCall(action, theme, context));
	return text;
}

export function shouldHideSearchResult(options: { expanded?: boolean }, context: any): boolean {
	return !context?.isError && (!options.expanded || isExplorationHidden(context?.toolCallId));
}

export function renderGutterBlock(lines: string[], theme: any): string {
	const body = lines.length > 0 ? lines : [theme.fg("muted", "(no output)")];
	return body
		.map((line, index) => {
			const prefix = index === body.length - 1 ? "  └ " : index === 0 ? "  ├ " : "  │ ";
			return `${theme.fg("dim", prefix)}${line}`;
		})
		.join("\n");
}

export function limitRenderedLines(
	lines: string[],
	options: { expanded?: boolean },
	maxLines: number,
	theme: any,
): string[] {
	if (options.expanded || lines.length <= maxLines) return lines;
	return [...lines.slice(0, maxLines), theme.fg("muted", `... (${lines.length - maxLines} more lines)`)];
}

function isNoticeLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("[") && trimmed.endsWith("]");
}

export function renderFindOutputLines(output: string, theme: any): string[] {
	if (!output || output === "No files found matching pattern") {
		return [theme.fg("muted", "No files found matching pattern")];
	}

	const groups = new Map<string, string[]>();
	const notices: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (isNoticeLine(line)) {
			notices.push(theme.fg("muted", line));
			continue;
		}
		const dir = path.posix.dirname(line);
		const file = path.posix.basename(line);
		const key = dir === "." ? "." : dir;
		const files = groups.get(key) ?? [];
		files.push(file);
		groups.set(key, files);
	}

	const lines: string[] = [];
	for (const [dir, files] of groups) {
		if (lines.length > 0) lines.push("");
		const label = dir === "." ? "./" : `${dir}/`;
		lines.push(theme.fg("accent", label));
		files.forEach((file, index) => {
			const branch = index === files.length - 1 ? "└ " : "├ ";
			lines.push(`  ${theme.fg("dim", branch)}${theme.fg("toolOutput", file)}`);
		});
	}
	if (notices.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...notices);
	}
	return lines;
}

type HighlightMode = "literal" | "regex";

export function renderGrepOutputLines(
	output: string,
	patterns: string[],
	theme: any,
	mode: HighlightMode = "literal",
): string[] {
	if (!output || output === "No matches found") {
		return [theme.fg("muted", "No matches found")];
	}

	const lines: string[] = [];
	let currentFile = "";
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) {
			lines.push("");
			continue;
		}
		if (isNoticeLine(line)) {
			lines.push(theme.fg("muted", line));
			continue;
		}

		const match = line.match(/^(.+?)([:-])(\d+)\2\s?(.*)$/);
		if (!match) {
			lines.push(theme.fg("toolOutput", line));
			continue;
		}

		const [, file, separator, lineNumber, content] = match;
		if (file !== currentFile) {
			if (currentFile) lines.push("");
			lines.push(theme.fg("accent", file));
			currentFile = file;
		}

		const paddedLineNumber = lineNumber.padStart(4, " ");
		const lineNumberText = theme.fg(separator === ":" ? "success" : "muted", paddedLineNumber);
		const body = highlightPatterns(content, patterns, theme, mode);
		lines.push(`  ${lineNumberText} ${theme.fg("dim", "│")} ${body}`);
	}
	return lines;
}

function highlightPatterns(text: string, patterns: string[], theme: any, mode: HighlightMode): string {
	const usablePatterns = patterns.filter((pattern) => pattern.length > 0);
	if (usablePatterns.length === 0) return theme.fg("toolOutput", text);

	try {
		const regex =
			mode === "regex"
				? new RegExp(usablePatterns.join("|"), "gi")
				: new RegExp(
						usablePatterns
							.sort((a, b) => b.length - a.length)
							.map(escapeRegex)
							.join("|"),
						"gi",
					);
		let lastIndex = 0;
		let highlighted = "";
		for (const match of text.matchAll(regex)) {
			const index = match.index ?? 0;
			if (match[0].length === 0) continue;
			highlighted += theme.fg("toolOutput", text.slice(lastIndex, index));
			highlighted += theme.bold(theme.fg("warning", match[0]));
			lastIndex = index + match[0].length;
		}
		highlighted += theme.fg("toolOutput", text.slice(lastIndex));
		return highlighted;
	} catch {
		return theme.fg("toolOutput", text);
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
