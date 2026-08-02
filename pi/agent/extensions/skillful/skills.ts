import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getCodexHiddenSkillNames, getCodexPluginAliases } from "../codex-native/plugin-aliases";

const SKILL_PREFIX = "skill:";
const DOLLAR_SKILL_NAME_RE = /^[a-zA-Z][\w-]*(?::[\w-]+)*/;
export const SKILLFUL_CUSTOM_TYPE = "skillful-load";

export type SkillReference = {
	name: string;
	filePath: string;
	description?: string;
};

export type SkillfulLoadStatus = "read";

export type SkillfulLoadDetails = {
	extension: "skillful";
	kind: "skill-load";
	name: string;
	status: SkillfulLoadStatus;
	filePath?: string;
	baseDir?: string;
	loads?: SkillfulLoadDetails[];
};

export function collectSkills(pi: ExtensionAPI): Map<string, SkillReference[]> {
	const direct = new Map<string, SkillReference>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill" || !cmd.name.startsWith(SKILL_PREFIX)) continue;
		const name = cmd.name.slice(SKILL_PREFIX.length).trim();
		const path = cmd.sourceInfo?.path;
		if (!name || !path || direct.has(name)) continue;
		direct.set(name, { name, filePath: path, ...(cmd.description ? { description: cmd.description } : {}) });
	}

	const out = new Map<string, SkillReference[]>();
	for (const [name, reference] of direct) out.set(name, [reference]);
	for (const [name, reference] of direct) {
		const alias = pluginAlias(name, reference.filePath);
		if (!alias) continue;
		if (direct.has(alias)) continue;
		const references = out.get(alias) ?? [];
		if (!references.some((candidate) => candidate.filePath === reference.filePath)) references.push(reference);
		out.set(alias, references);
	}
	for (const alias of getCodexPluginAliases()) {
		if (!out.has(alias)) out.set(alias, []);
	}
	return out;
}

function pluginAlias(name: string, filePath: string): string | undefined {
	const separator = name.indexOf(":");
	if (separator > 0) return name.slice(0, separator);

	const normalizedPath = filePath.replaceAll("\\", "/");
	return normalizedPath.match(/(?:^|\/)\.codex\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+(?:\/|$)/)?.[1];
}

export function buildItems(
	skills: Map<string, SkillReference[]>,
	hiddenSkillNames: Iterable<string> = getCodexHiddenSkillNames(),
): AutocompleteItem[] {
	const hidden = new Set(hiddenSkillNames);
	return [...skills.entries()]
		.filter(([name]) => !hidden.has(name))
		.map(([name, references]) => ({
			value: `$${name}`,
			label: `$${name}`,
			description:
				[...new Set(references.map((reference) => reference.description).filter(Boolean))].join(" • ") || "skill",
		}));
}

export function extractDollarSkillReferences(text: string, skills: Iterable<string>): string[] {
	const referenced: string[] = [];
	for (const { name } of findDollarSkillReferences(text, skills)) {
		if (!referenced.includes(name)) referenced.push(name);
	}
	return referenced;
}

export function findDollarSkillReferences(
	text: string,
	skills: Iterable<string>,
): Array<{ name: string; start: number; end: number }> {
	const known = skills instanceof Set ? skills : new Set(skills);
	const references: Array<{ name: string; start: number; end: number }> = [];
	let quote: { char: "'" | '"' | "`"; length: number } | undefined;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (!char) continue;

		if (quote) {
			if (quote.char === "`") {
				if (text.startsWith("`".repeat(quote.length), index)) {
					index += quote.length - 1;
					quote = undefined;
				}
				continue;
			}
			if (char === quote.char && !isEscaped(text, index)) quote = undefined;
			continue;
		}

		if (char === "`") {
			quote = { char, length: backtickRunLength(text, index) };
			index += quote.length - 1;
			continue;
		}
		if ((char === '"' || char === "'") && isQuoteStart(text, index, char)) {
			quote = { char, length: 1 };
			continue;
		}
		if (char !== "$" || !isDollarSkillTriggerStart(text, index)) continue;

		const match = text.slice(index + 1).match(DOLLAR_SKILL_NAME_RE);
		const name = match?.[0];
		if (!name) continue;
		if (known.has(name)) references.push({ name, start: index, end: index + name.length + 1 });
		index += name.length;
	}

	return references;
}

function isDollarSkillTriggerStart(text: string, index: number): boolean {
	return index === 0 || /\s/.test(text[index - 1] ?? "");
}

function backtickRunLength(text: string, index: number): number {
	let length = 0;
	while (text[index + length] === "`") length += 1;
	return length;
}

function isQuoteStart(text: string, index: number, quote: "'" | '"'): boolean {
	if (isEscaped(text, index)) return false;
	if (quote === "'") {
		const prev = text[index - 1] ?? "";
		if (/\w/.test(prev)) return false;
	}
	return true;
}

function isEscaped(text: string, index: number): boolean {
	let slashCount = 0;
	for (let pos = index - 1; text[pos] === "\\"; pos -= 1) slashCount += 1;
	return slashCount % 2 === 1;
}

export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 4);
	return after === -1 ? "" : text.slice(after + 1);
}

export function rewriteSlashSkillReferences(text: string, skills: Iterable<string>): string {
	const names = [...skills].filter(Boolean).sort((a, b) => b.length - a.length);
	if (names.length === 0 || !text.includes("/")) return text;
	const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(?<![\\w$~.])\\/(${escaped.join("|")})(?=(?:\\s|\`|[.,;:)<]|$))`, "g");
	return text.replace(pattern, (_match, name: string) => `$${name}`);
}

export function skillBaseDir(filePath: string): string {
	return dirname(filePath);
}

export function loadedDetails(
	name: string,
	status: SkillfulLoadStatus,
	filePath?: string,
	baseDir?: string,
): SkillfulLoadDetails {
	return {
		extension: "skillful",
		kind: "skill-load",
		name,
		status,
		filePath,
		baseDir,
	};
}

export function formatReadSkillContent(name: string, filePath: string, body: string): string {
	const baseDir = skillBaseDir(filePath);
	return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

export function isSkillfulLoadDetails(value: unknown): value is SkillfulLoadDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<SkillfulLoadDetails>;
	return details.extension === "skillful" && details.kind === "skill-load" && typeof details.name === "string";
}
