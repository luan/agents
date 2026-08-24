export const MAX_RESULTS = 8;

const K1 = 1.2;
const B = 0.75;
const MAX_SCHEMA_DEPTH = 6;
const MIN_PREFIX_LENGTH = 3;

export interface ToolMetadata {
	name: string;
	description: string;
	parameters?: unknown;
	sourceInfo?: unknown;
}

interface IndexedTool {
	tool: ToolMetadata;
	frequencies: Map<string, number>;
	length: number;
}

export interface ToolSearchMatch {
	tool: ToolMetadata;
	score: number;
}

function stem(term: string): string {
	for (const suffix of ["ing", "es", "ed", "s"]) {
		if (term.length > suffix.length + 2 && term.endsWith(suffix)) return term.slice(0, -suffix.length);
	}
	return term;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 1)
		.map(stem);
}

function appendSchemaText(schema: unknown, depth: number, output: string[]): void {
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > MAX_SCHEMA_DEPTH) return;
	const node = schema as Record<string, unknown>;
	if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
		for (const [name, value] of Object.entries(node.properties as Record<string, unknown>)) {
			output.push(name, name.replaceAll("_", " "));
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const description = (value as Record<string, unknown>).description;
				if (typeof description === "string") output.push(description);
			}
			appendSchemaText(value, depth + 1, output);
		}
	}
	appendSchemaText(node.items, depth + 1, output);
	for (const variant of [
		...(Array.isArray(node.anyOf) ? node.anyOf : []),
		...(Array.isArray(node.oneOf) ? node.oneOf : []),
	]) {
		appendSchemaText(variant, depth + 1, output);
	}
}

function searchFields(tool: ToolMetadata): string[] {
	const fields = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	appendSchemaText(tool.parameters, 0, fields);
	return fields;
}

function indexTool(tool: ToolMetadata): IndexedTool {
	const frequencies = new Map<string, number>();
	let length = 0;
	for (const field of searchFields(tool)) {
		for (const term of tokenize(field)) {
			frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
			length++;
		}
	}
	return { tool, frequencies, length };
}

function frequencyOf(document: IndexedTool, term: string): number {
	const exact = document.frequencies.get(term);
	if (exact) return exact;
	if (term.length < MIN_PREFIX_LENGTH) return 0;
	let total = 0;
	for (const [candidate, count] of document.frequencies) {
		if (candidate.startsWith(term)) total += count;
	}
	return total;
}

export function searchTools(query: string, tools: readonly ToolMetadata[], limit = MAX_RESULTS): ToolSearchMatch[] {
	const documents = tools.map(indexTool);
	const queryTerms = [...new Set(tokenize(query))];
	if (documents.length === 0 || queryTerms.length === 0) return [];

	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const scores = new Float64Array(documents.length);
	for (const term of queryTerms) {
		const frequencies = documents.map((document) => frequencyOf(document, term));
		const containing = frequencies.reduce((count, frequency) => count + (frequency > 0 ? 1 : 0), 0);
		if (containing === 0) continue;
		const inverseDocumentFrequency = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
		for (let index = 0; index < documents.length; index++) {
			const frequency = frequencies[index] ?? 0;
			if (frequency === 0) continue;
			const document = documents[index]!;
			scores[index] +=
				(inverseDocumentFrequency * frequency * (K1 + 1)) /
				(frequency + K1 * (1 - B + (B * document.length) / averageLength));
		}
	}

	const resultLimit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(limit) || MAX_RESULTS));
	return documents
		.map((document, index) => ({ tool: document.tool, score: scores[index] ?? 0 }))
		.filter((match) => match.score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
		.slice(0, resultLimit);
}
