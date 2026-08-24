import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SKILLS_SETTINGS, type SkillsSettings } from "./contributions/xsettings.ts";

const REGISTRY_KEY = Symbol.for("pi-developer-prompt/developer-messages/v1");
const CONTRIBUTION_ID = "pi-skills/catalog";

interface RenderContext {
	systemPromptOptions: BuildSystemPromptOptions;
	activeTools: readonly string[];
}

interface Contribution {
	id: string;
	priority: number;
	activeTools: readonly string[];
	content: (context: RenderContext) => string | undefined;
}

interface ContributionRegistry extends Map<string, Contribution> {
	protocol: "pi-developer-prompt/developer-messages/v1";
	version: 1;
}
type ContributionGlobal = typeof globalThis & { [REGISTRY_KEY]?: ContributionRegistry };

export function registerSkillsPromptContribution(
	getSettings: () => SkillsSettings = () => DEFAULT_SKILLS_SETTINGS,
): () => void {
	const root = globalThis as ContributionGlobal;
	const registry = isContributionRegistry(root[REGISTRY_KEY])
		? root[REGISTRY_KEY]
		: (Object.assign(new Map<string, Contribution>(), {
				protocol: "pi-developer-prompt/developer-messages/v1" as const,
				version: 1 as const,
			}) as ContributionRegistry);
	root[REGISTRY_KEY] = registry;
	const contribution: Contribution = {
		id: CONTRIBUTION_ID,
		priority: 50,
		activeTools: [],
		content: ({ systemPromptOptions, activeTools }) => {
			const visibility = getSettings().catalogVisibility;
			if (visibility === "off") return undefined;
			if (visibility === "when-active" && !activeTools.includes("skill") && !activeTools.includes("exec")) {
				return undefined;
			}
			return renderSkillsCatalog(systemPromptOptions.skills ?? []);
		},
	};
	registry.set(CONTRIBUTION_ID, contribution);
	return () => {
		if (registry.get(CONTRIBUTION_ID) === contribution) registry.delete(CONTRIBUTION_ID);
	};
}

export function renderSkillsCatalog(skills: readonly Skill[]): string | undefined {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return undefined;
	const body = [
		"## Skills",
		"A skill is a set of instructions in a `SKILL.md` file.",
		"- Use a skill when the user names it or when the task clearly matches its description.",
		"- Use the smallest set of skills that covers the request.",
		"- Call `tools.skill` with the exact skill name inside `exec` before you act.",
		"- The loaded `SKILL.md` body arrives as a contextual user message without frontmatter.",
		"- Use the returned skill directory to resolve supporting files when it is present.",
		"- Load only the supporting files required by the task.",
		"- Prefer supplied scripts, assets, and templates.",
		"- State which skills you use and why.",
		"- If a skill is unavailable, state that briefly and continue with the best fallback.",
		"### Available skills",
		...visible.map((skill) => `- ${escapeXml(skill.name)}: ${escapeXml(skill.description)}`),
	].join("\n");
	return `<skills_instructions>\n${body}\n</skills_instructions>`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isContributionRegistry(value: unknown): value is ContributionRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ContributionRegistry>;
	return (
		candidate.protocol === "pi-developer-prompt/developer-messages/v1" &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.values === "function"
	);
}
