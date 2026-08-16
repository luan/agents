type Schema = Record<string, unknown>;

const string = { type: "string" } as const;
const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;

export const EDIT_DETAILS_SCHEMA: Schema = {
	title: "EditDetails",
	type: "object",
	properties: {
		changes: {
			type: "array",
			items: {
				type: "object",
				properties: { path: string, hashlineTag: string },
				required: ["path", "hashlineTag"],
			},
		},
		firstChangedLine: number,
		changesTruncated: boolean,
	},
};

export const SEARCH_DETAILS_SCHEMA: Schema = {
	title: "SearchDetails",
	type: "object",
	properties: {
		hits: {
			type: "array",
			items: {
				type: "object",
				properties: { path: string, line: number, ref: string, text: string },
				required: ["path", "text"],
			},
		},
		hitsTruncated: boolean,
	},
	required: ["hits"],
};

export const READ_DETAILS_SCHEMA: Schema = {
	title: "ReadDetails",
	type: "object",
	properties: {
		hashlineTag: string,
		ranges: {
			type: "array",
			items: {
				type: "object",
				properties: { start: number, end: number },
				required: ["start", "end"],
			},
		},
		readKind: { enum: ["archive", "sqlite", "pdf", "binary"] },
		entryCount: number,
		tableCount: number,
		bytes: number,
		outputTokens: number,
		outputBounded: boolean,
	},
};

export const FIND_DETAILS_SCHEMA: Schema = {
	title: "FindDetails",
	type: "object",
	properties: { outputTokens: number, outputBounded: boolean },
	required: ["outputTokens", "outputBounded"],
};

export const WRITE_DETAILS_SCHEMA: Schema = {
	title: "WriteDetails",
	type: "object",
	properties: { bytes: number },
};

export const AST_GREP_DETAILS_SCHEMA: Schema = {
	title: "AstGrepDetails",
	type: "object",
	properties: { matches: number, diagnostics: string },
	required: ["matches"],
};

export const AST_EDIT_DETAILS_SCHEMA: Schema = {
	title: "AstEditDetails",
	type: "object",
	properties: { matches: number, applied: boolean },
	required: ["matches", "applied"],
};

const EDIT_CHANGE_LIMIT = 20;
const SEARCH_HIT_LIMIT = 20;
export const EDIT_VALIDATION_ENTRY_TYPE = "code_mode_edit_validation";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Counts stay session-only; projectEditDetails remains model-facing and omits validation. */
export function editValidationCounts(details: unknown): { checked: number; unchecked: number } | undefined {
	const source = record(details);
	const results = source && Array.isArray(source.results) ? source.results : [];
	let checked = 0;
	let unchecked = 0;
	for (const value of results) {
		const validation = record(value);
		if (validation && validation.validation === "checked") checked++;
		else if (validation && validation.validation === "unchecked") unchecked++;
	}
	return checked + unchecked > 0 ? { checked, unchecked } : undefined;
}

function projectFields(details: unknown, fields: readonly string[]): unknown {
	const source = record(details);
	if (!source) return undefined;
	const projected: Record<string, unknown> = {};
	for (const field of fields) if (source[field] !== undefined) projected[field] = source[field];
	return Object.keys(projected).length > 0 ? projected : undefined;
}

export function projectReadDetails(details: unknown): unknown {
	return projectFields(details, [
		"hashlineTag",
		"ranges",
		"readKind",
		"entryCount",
		"tableCount",
		"bytes",
		"outputTokens",
		"outputBounded",
	]);
}

export function projectFindDetails(details: unknown): unknown {
	return projectFields(details, ["outputTokens", "outputBounded"]);
}

export function projectWriteDetails(details: unknown): unknown {
	return projectFields(details, ["bytes"]);
}

export function projectEditDetails(details: unknown): unknown {
	const source = record(details);
	if (!source) return undefined;
	const results = Array.isArray(source.results) ? source.results : [];
	const changes = results.flatMap((value) => {
		const result = record(value);
		if (!result || typeof result.path !== "string" || typeof result.header !== "string") return [];
		const tag = /#([0-9A-Fa-f]{4})\]$/.exec(result.header)?.[1];
		return tag ? [{ path: result.path, hashlineTag: tag }] : [];
	});
	const projected: Record<string, unknown> = {};
	if (changes.length > 0) projected.changes = changes.slice(0, EDIT_CHANGE_LIMIT);
	if (changes.length > EDIT_CHANGE_LIMIT) projected.changesTruncated = true;
	if (typeof source.firstChangedLine === "number") projected.firstChangedLine = source.firstChangedLine;
	return Object.keys(projected).length > 0 ? projected : undefined;
}

export function projectSearchDetails(details: unknown, text: string): unknown {
	const hits: Array<{ path: string; line?: number; ref?: string; text: string }> = [];
	let path: string | undefined;
	for (const row of text.split("\n")) {
		const header = /^\[(.+)#[0-9A-Fa-f]{4}\]$/.exec(row);
		if (header) {
			path = header[1];
			continue;
		}
		const match = /^\*([1-9]\d*):(.*)$/.exec(row);
		if (path && match) {
			const line = Number(match[1]);
			hits.push({ path, line, ref: `${path}:${line}`, text: (match[2] ?? "").slice(0, 250) });
		}
	}
	const source = record(details);
	const resources = source?.resources;
	if (hits.length === 0 && Array.isArray(resources)) {
		for (const value of resources) {
			const resource = record(value);
			const resourcePath =
				resource && [resource.uri, resource.path, resource.name].find((item) => typeof item === "string");
			if (typeof resourcePath !== "string" || typeof resource?.snippet !== "string") continue;
			hits.push({ path: resourcePath, text: resource.snippet.slice(0, 250) });
		}
	}
	const sections = source?.highlightedSections;
	if (hits.length === 0 && Array.isArray(sections)) {
		const blocks = text.split(/\n{2,}/);
		for (const [index, value] of sections.entries()) {
			const section = record(value);
			if (typeof section?.path !== "string") continue;
			for (const row of (blocks[index] ?? "").split("\n")) {
				const match = /^\*([1-9]\d*):(.*)$/.exec(row);
				if (match) {
					const line = Number(match[1]);
					hits.push({
						path: section.path,
						line,
						ref: `${section.path}:${line}`,
						text: (match[2] ?? "").slice(0, 250),
					});
				}
			}
		}
	}
	return {
		hits: hits.slice(0, SEARCH_HIT_LIMIT),
		...(hits.length > SEARCH_HIT_LIMIT ? { hitsTruncated: true } : {}),
	};
}

export function projectAstEditDetails(details: unknown): unknown {
	const source = record(details);
	if (!source) return undefined;
	const projected: Record<string, unknown> = {};
	if (typeof source.matches === "number") projected.matches = source.matches;
	if (typeof source.applied === "boolean") projected.applied = source.applied;
	return Object.keys(projected).length > 0 ? projected : undefined;
}
