/** Answers "where" (the file tag answers "which version"); 2 chars accept a measured 0.40% of stale anchors. */
export const HL_LINE_HASH_LENGTH = 2;

function normalizeForLineHash(line: string): string {
	return line.replace(/[ \t\r]+$/, "");
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

export function lineHashAt(lines: readonly string[], lineNumber: number): string {
	const at = (index: number): string => normalizeForLineHash(lines[index] ?? "");
	const joined = `${at(lineNumber - 2)}\n${at(lineNumber - 1)}\n${at(lineNumber)}`;
	const modulus = 16 ** HL_LINE_HASH_LENGTH;
	return (fnv1a(joined) % modulus).toString(16).padStart(HL_LINE_HASH_LENGTH, "0").toLowerCase();
}

export function lineHashes(text: string): string[] {
	const lines = text.split("\n");
	return lines.map((_line, index) => lineHashAt(lines, index + 1));
}

export function lineHashMatches(lines: readonly string[], lineNumber: number, hash: string): boolean {
	return lineHashAt(lines, lineNumber) === hash.toLowerCase();
}
