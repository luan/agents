import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_COMMAND_PREFIX = "skill:";
const ALLOWED_SKILL_FILES = new Set(["SKILL.md", "agents/openai.yaml"]);

export interface SkillReference {
	name: string;
	filePath: string;
}

export interface LoadedSkill {
	name: string;
	filePath: string;
	directory: string;
	content: string;
	hasSupportingFiles: boolean;
	supportingFiles: string[];
	supportingFilesTruncated: boolean;
	frontmatterRemoved: boolean;
	sourceChars: number;
}

const MAX_SUPPORTING_FILE_COUNT = 256;

export function discoverSkills(pi: Pick<ExtensionAPI, "getCommands">): Map<string, SkillReference> {
	const skills = new Map<string, SkillReference>();
	for (const command of pi.getCommands()) {
		if (command.source !== "skill" || !command.name.startsWith(SKILL_COMMAND_PREFIX)) continue;
		const name = command.name.slice(SKILL_COMMAND_PREFIX.length).trim();
		const filePath = command.sourceInfo?.path;
		if (!name || !filePath || skills.has(name)) continue;
		skills.set(name, { name, filePath: resolve(filePath) });
	}
	return skills;
}

export async function loadSkill(reference: SkillReference): Promise<LoadedSkill> {
	const filePath = resolve(reference.filePath);
	const directory = dirname(filePath);
	const source = await readFile(filePath, "utf8");
	const body = stripFrontmatter(source);
	const supportingFiles = await listSupportingFiles(directory);
	const hasSupportingFiles = supportingFiles.paths.length > 0;
	return {
		name: reference.name,
		filePath,
		directory,
		content: hasSupportingFiles ? appendSkillDirectory(body, directory) : body,
		hasSupportingFiles,
		supportingFiles: supportingFiles.paths,
		supportingFilesTruncated: supportingFiles.truncated,
		frontmatterRemoved: body !== source,
		sourceChars: source.length,
	};
}

export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const body = text.indexOf("\n", end + 4);
	return body === -1 ? "" : text.slice(body + 1);
}

async function listSupportingFiles(
	root: string,
	directory = root,
	paths: string[] = [],
): Promise<{ paths: string[]; truncated: boolean }> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		const relativePath = relative(root, path).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			const nested = await listSupportingFiles(root, path, paths);
			if (nested.truncated) return nested;
			continue;
		}
		if (ALLOWED_SKILL_FILES.has(relativePath)) continue;
		if (paths.length >= MAX_SUPPORTING_FILE_COUNT) return { paths, truncated: true };
		paths.push(relativePath);
	}
	return { paths, truncated: false };
}

function appendSkillDirectory(body: string, directory: string): string {
	const separator = body.endsWith("\n") ? "\n" : "\n\n";
	return `${body}${separator}Skill directory: ${directory}`;
}
