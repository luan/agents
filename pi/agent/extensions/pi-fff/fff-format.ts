import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { GrepCursor, GrepResult, SearchResult } from "@ff-labs/fff-node";

const GREP_MAX_LINE_LENGTH = 500;

export class CursorStore {
	private cursors = new Map<string, GrepCursor>();
	private counter = 0;

	constructor(private maxSize = 200) {}

	store(cursor: GrepCursor): string {
		const id = `fff_c${++this.counter}`;
		this.cursors.set(id, cursor);
		if (this.cursors.size > this.maxSize) {
			const first = this.cursors.keys().next().value;
			if (first) this.cursors.delete(first);
		}
		return id;
	}

	get(id: string): GrepCursor | undefined {
		return this.cursors.get(id);
	}
}

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export function formatGrepOutput(result: GrepResult, limit: number): string {
	const items = result.items.slice(0, limit);
	if (items.length === 0) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of items) {
		if (match.relativePath !== currentFile) {
			currentFile = match.relativePath;
			if (lines.length > 0) lines.push("");
		}

		match.contextBefore?.forEach((line: string, i: number) => {
			lines.push(
				`${match.relativePath}-${match.lineNumber - match.contextBefore!.length + i}- ${truncateLine(line)}`,
			);
		});

		lines.push(`${match.relativePath}:${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		match.contextAfter?.forEach((line: string, i: number) => {
			lines.push(`${match.relativePath}-${match.lineNumber + 1 + i}- ${truncateLine(line)}`);
		});
	}

	return lines.join("\n");
}

export function formatFindOutput(result: SearchResult, limit: number): string {
	const items = result.items.slice(0, limit);
	return items.length === 0
		? "No files found matching pattern"
		: items.map((i: { relativePath: string }) => i.relativePath).join("\n");
}

function toFffPath(value: string): string {
	return value.split(path.sep).join("/");
}

export function normalizePathConstraint(rawPath: string | undefined, cwd: string): string | undefined {
	const trimmed = rawPath?.trim();
	if (!trimmed) return undefined;

	const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
	const relativePath = path.isAbsolute(trimmed) ? path.relative(cwd, absolutePath) : trimmed;

	if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath) && existsSync(absolutePath)) {
		const normalized = toFffPath(relativePath);
		return statSync(absolutePath).isDirectory() && !normalized.endsWith("/") ? `${normalized}/` : normalized;
	}

	return toFffPath(trimmed);
}

export function normalizeConstraintExpression(rawConstraints: string | undefined, cwd: string): string | undefined {
	const trimmed = rawConstraints?.trim();
	if (!trimmed) return undefined;

	return trimmed
		.split(/\s+/)
		.map((constraint) => {
			const negated = constraint.startsWith("!");
			const value = negated ? constraint.slice(1) : constraint;
			const normalized = normalizePathConstraint(value, cwd) ?? value;
			return negated ? `!${normalized}` : normalized;
		})
		.join(" ");
}
