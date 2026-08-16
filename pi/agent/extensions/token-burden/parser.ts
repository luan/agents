/**
 * Parse the assembled system prompt into measurable sections.
 *
 * The system prompt built by pi follows a predictable structure:
 *   1. Base prompt (tools, guidelines, pi docs reference)
 *   2. Optional SYSTEM.md / APPEND_SYSTEM.md content
 *   3. Project Context (AGENTS.md files, each under `## <path>`)
 *   4. Skills preamble + <available_skills> block
 *   5. Environment context metadata
 */

/**
 * Nothing in this file is measured, and it says so.
 *
 * The system prompt is text the provider never itemises: usage reports one
 * prompt total, not a line for the base prompt and another for AGENTS.md. So
 * the split below is an estimate and stays one. It is deliberately the same
 * estimate the rest of the repo uses — `approxTokenCount`, bytes over four —
 * rather than a BPE encoder, because a second opinion that is precise about the
 * wrong quantity reads as authority it has not earned. The exact figure this
 * breakdown sits under is the measured session floor.
 */

import { approxTokenCount } from "../shared/output-budget.ts";
import type { AgentsFileEntry, ParsedPrompt, PromptSection, SkillEntry, ToolEntry } from "./types.js";
import { ToolReach } from "./types.js";

export type { ParsedPrompt };

// ---------------------------------------------------------------------------
// Internal helpers (defined before use to satisfy no-use-before-define)
// ---------------------------------------------------------------------------

function measure(label: string, text: string): PromptSection {
	return {
		label,
		chars: text.length,
		tokens: approxTokenCount(text),
		content: text,
	};
}

/** Return the smallest positive value, or -1 if none are positive. */
function firstPositive(...values: number[]): number {
	let min = -1;
	for (const v of values) {
		if (v >= 0 && (min < 0 || v < min)) {
			min = v;
		}
	}
	return min;
}

function findSkillsPreamble(prompt: string): number {
	const idx = prompt.indexOf("The following skills provide specialized instructions");
	if (idx === -1) return -1;
	const sectionStart = prompt.lastIndexOf("\n<skills_instructions>", idx);
	return sectionStart === -1 ? idx : sectionStart + 1;
}

function findMetadataFooter(prompt: string): number {
	const environmentContextIdx = prompt.lastIndexOf("\n<environment_context>");
	if (environmentContextIdx !== -1) return environmentContextIdx;
	const currentDateTimeIdx = prompt.lastIndexOf("\nCurrent date and time:");
	if (currentDateTimeIdx !== -1) return currentDateTimeIdx;
	return prompt.lastIndexOf("\nCurrent date:");
}

/**
 * Find where the base system prompt ends.
 *
 * The base prompt ends after the pi docs reference block. We look for
 * "- Always read pi .md files" or "- When working on pi" as the terminal
 * marker. Falls back to the first major section boundary.
 */
function findBasePromptEnd(
	prompt: string,
	projectCtxIdx: number,
	skillsPreambleIdx: number,
	dateLineIdx: number,
): number {
	const piDocsMarker = /^- (?:Always read pi|When working on pi).+$/gm;
	let lastPiDocsEnd = -1;
	for (const match of prompt.matchAll(piDocsMarker)) {
		lastPiDocsEnd = match.index + match[0].length;
	}

	if (lastPiDocsEnd !== -1) {
		return lastPiDocsEnd;
	}

	return firstPositive(projectCtxIdx, skillsPreambleIdx, dateLineIdx);
}

/** Parse `## /path/to/AGENTS.md` blocks inside the Project Context section. */
function parseAgentsFiles(contextBlock: string): AgentsFileEntry[] {
	const files: AgentsFileEntry[] = [];
	// Match `## ` headings that look like file paths (start with `/`).
	const headingPattern = /^## (\/.+)$/gm;
	const matches = [...contextBlock.matchAll(headingPattern)];

	for (let i = 0; i < matches.length; i++) {
		const [, path] = matches[i];
		const blockStart = matches[i].index;
		const blockEnd = i + 1 < matches.length ? matches[i + 1].index : contextBlock.length;
		const blockText = contextBlock.slice(blockStart, blockEnd);
		files.push({
			path,
			chars: blockText.length,
			tokens: approxTokenCount(blockText),
		});
	}

	return files;
}

/** Parse legacy `<skill>` entries from the `<available_skills>` block. */
function parseXmlSkillEntries(skillsBlock: string, out: SkillEntry[]): number {
	const skillPattern = /<skill>([\s\S]*?)<\/skill>/g;
	const namePattern = /<name>([\s\S]*?)<\/name>/;
	const descPattern = /<description>([\s\S]*?)<\/description>/;
	let parsedCount = 0;

	for (const match of skillsBlock.matchAll(skillPattern)) {
		const [fullEntry, inner] = match;
		const name = inner.match(namePattern)?.[1]?.trim() ?? "unknown";
		const description = inner.match(descPattern)?.[1]?.trim() ?? "";

		out.push({
			name,
			description,
			chars: fullEntry.length,
			tokens: approxTokenCount(fullEntry),
		});
		parsedCount++;
	}

	return parsedCount;
}

/** Parse `- name: description` entries from the skills block. */
function parseYamlSkillEntries(skillsBlock: string, out: SkillEntry[]): void {
	const skillPattern = /^-\s+([^:\n]+):\s*(.*?)\s*$/gm;

	for (const match of skillsBlock.matchAll(skillPattern)) {
		const [fullEntry, rawName, rawDescription] = match;
		const name = rawName.trim();
		if (!name) {
			continue;
		}

		const description = rawDescription.trim();

		out.push({
			name,
			description,
			chars: fullEntry.length,
			tokens: approxTokenCount(fullEntry),
		});
	}
}

function parseSkillEntries(skillsBlock: string, out: SkillEntry[]): void {
	if (parseXmlSkillEntries(skillsBlock, out) > 0) {
		return;
	}
	parseYamlSkillEntries(skillsBlock, out);
}

/** Compute the skills section end index, avoiding nested ternaries. */
function findSkillsSectionEnd(availableSkillsEnd: number, dateLineIdx: number, promptLength: number): number {
	if (availableSkillsEnd !== -1) {
		return availableSkillsEnd + "</available_skills>".length;
	}
	if (dateLineIdx !== -1) {
		return dateLineIdx;
	}
	return promptLength;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a system prompt string into sections with token estimates.
 *
 * Uses known structural markers emitted by `buildSystemPrompt()`:
 *   - `# Project Context` heading
 *   - `The following skills provide specialized instructions` preamble
 *   - `<available_skills>` / `</available_skills>` skill list block
 *   - `<environment_context>` metadata footer
 */
export function parseSystemPrompt(prompt: string): ParsedPrompt {
	const sections: PromptSection[] = [];
	const skills: SkillEntry[] = [];

	const projectCtxIdx = prompt.indexOf("\n\n# Project Context\n");
	const skillsPreambleIdx = findSkillsPreamble(prompt);
	const availableSkillsStart = prompt.indexOf("<available_skills>");
	const availableSkillsEnd = prompt.indexOf("</available_skills>");
	const dateLineIdx = findMetadataFooter(prompt);

	// 1. Base system prompt
	const baseEnd = findBasePromptEnd(prompt, projectCtxIdx, skillsPreambleIdx, dateLineIdx);
	const baseText = baseEnd >= 0 ? prompt.slice(0, baseEnd) : prompt;
	sections.push(measure("Base prompt", baseText));

	// 2. Project Context / AGENTS.md files
	if (projectCtxIdx !== -1) {
		const contextStart = projectCtxIdx + 2; // skip leading \n\n
		const contextEnd = firstPositive(skillsPreambleIdx, dateLineIdx);
		const contextBlock = contextEnd >= 0 ? prompt.slice(contextStart, contextEnd) : prompt.slice(contextStart);

		const agentsFiles = parseAgentsFiles(contextBlock);
		const children = agentsFiles.map((f) => ({
			label: f.path,
			chars: f.chars,
			tokens: f.tokens,
		}));

		sections.push({
			...measure("AGENTS.md files", contextBlock),
			children,
		});
	}

	// 3. Skills section
	if (skillsPreambleIdx !== -1) {
		const skillsSectionStart = skillsPreambleIdx + 2;
		const skillsSectionEnd = findSkillsSectionEnd(availableSkillsEnd, dateLineIdx, prompt.length);
		const skillsSectionText = prompt.slice(skillsSectionStart, skillsSectionEnd);

		if (availableSkillsStart !== -1 && availableSkillsEnd !== -1) {
			const skillsBlock = prompt.slice(availableSkillsStart, availableSkillsEnd + "</available_skills>".length);
			parseSkillEntries(skillsBlock, skills);
		}

		const children = skills.map((s) => ({
			label: s.name,
			chars: s.chars,
			tokens: s.tokens,
		}));

		sections.push({
			...measure(`Skills (${String(skills.length)})`, skillsSectionText),
			children,
		});
	}

	// 4. Metadata footer
	if (dateLineIdx !== -1) {
		const metaText = prompt.slice(dateLineIdx + 1);
		sections.push(measure("Metadata (environment context)", metaText));
	}

	// 5. Detect SYSTEM.md / APPEND_SYSTEM.md gap
	const nextSectionStart = projectCtxIdx === -1 ? skillsPreambleIdx : projectCtxIdx;

	if (baseEnd >= 0 && nextSectionStart >= 0 && nextSectionStart > baseEnd) {
		const gap = prompt.slice(baseEnd, nextSectionStart);
		const trimmed = gap.trim();
		if (trimmed.length > 0) {
			sections.splice(1, 0, measure("SYSTEM.md / APPEND_SYSTEM.md", trimmed));
		}
	}

	const totalChars = prompt.length;
	const totalTokens = approxTokenCount(prompt);

	return { sections, totalChars, totalTokens, skills };
}

// ---------------------------------------------------------------------------
// Tool definitions section
// ---------------------------------------------------------------------------

interface ToolDefinitionInput {
	name: string;
	description: string;
	parameters: unknown;
}

interface JsonSchemaLike {
	properties?: unknown;
	required?: unknown;
}

/**
 * Serialise one tool the way the provider request does.
 *
 * Mirrors `pi-ai`'s `anthropic-messages.js` on the non-strict path: name,
 * description, and an `input_schema` rebuilt from the schema's `properties` and
 * `required`. A pretty-printed dump of pi's whole definition object — which is
 * what this section used to count — is not a payload anybody is billed for, and
 * it read high by every byte of indentation.
 */
function wireFormat(tool: ToolDefinitionInput): unknown {
	const schema = (tool.parameters ?? {}) as JsonSchemaLike;
	return {
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		},
	};
}

/**
 * Build a PromptSection for tool schemas, one entry per registered tool.
 *
 * Schemas are not part of the system prompt text — they ride the tool-calling
 * API — but only for a tool on the direct surface. So the section's own token
 * count is the direct schemas alone, and every other tool travels in the entry
 * list carrying the cost it is *not* charging. `declarationTokens` is resident
 * too, but it is already inside the base prompt section and is passed through
 * for display rather than added again here.
 *
 * Returns null if there are no tools.
 */
export function buildToolDefinitionsSection(
	tools: ToolDefinitionInput[],
	reachOf: (toolName: string) => ToolReach,
	declarationTokens = 0,
): PromptSection | null {
	if (tools.length === 0) {
		return null;
	}

	const entries: ToolEntry[] = tools.map((tool) => {
		const wire = wireFormat(tool);
		const serialized = JSON.stringify(wire);
		return {
			name: tool.name,
			chars: serialized.length,
			tokens: approxTokenCount(serialized),
			content: JSON.stringify(wire, null, 2),
			reach: reachOf(tool.name),
		};
	});

	const direct = entries.filter((entry) => entry.reach === ToolReach.Direct);
	const residentTokens = direct.reduce((sum, entry) => sum + entry.tokens, 0);
	const registeredTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);

	return {
		label: `Tool schemas (${String(direct.length)} resident of ${String(entries.length)})`,
		chars: direct.reduce((sum, entry) => sum + entry.chars, 0),
		tokens: residentTokens,
		tools: {
			tools: entries,
			residentTokens,
			registeredTokens,
			declarationTokens,
		},
	};
}
