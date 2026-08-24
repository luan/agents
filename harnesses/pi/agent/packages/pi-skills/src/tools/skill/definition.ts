import { estimateTokens, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LOADED_SKILL_CONTEXT_MESSAGE_TYPE, renderLoadedSkillContext } from "../../loaded-skill-context.ts";
import { discoverSkills, loadSkill } from "../../skills.ts";
import { renderSkillCall, renderSkillResult } from "./presentation.ts";

const SKILL_PARAMETERS = {
	type: "object",
	properties: {
		name: { type: "string", description: "Exact skill name" },
	},
	required: ["name"],
	additionalProperties: false,
} as const;

export interface SkillToolDetails {
	version: 1;
	tool: "skill";
	status: "loaded";
	requestedName: string;
	name: string;
	filePath: string;
	directory: string;
	hasSupportingFiles: boolean;
	supportingFiles: string[];
	supportingFilesTruncated: boolean;
	frontmatterRemoved: boolean;
	sourceChars: number;
	loadedChars: number;
	loadedTokens: number;
	/** Presentation payload; model context is still delivered by the custom message. */
	instructions: string;
}

export function createSkillTool(
	pi: Pick<ExtensionAPI, "getCommands" | "sendMessage">,
): ToolDefinition<typeof SKILL_PARAMETERS, SkillToolDetails> {
	return {
		name: "skill",
		label: "Skill",
		description: "Load the complete instructions for a skill by exact name.",
		promptSnippet: "Load a named skill before following its instructions.",
		parameters: SKILL_PARAMETERS,
		executionMode: "sequential",
		renderShell: "self",
		renderCall(parameters, theme, context) {
			return renderSkillCall(parameters.name, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderSkillResult(result, theme, context, options.expanded);
		},
		async execute(_toolCallId, parameters) {
			const reference = discoverSkills(pi).get(parameters.name);
			if (!reference) throw new Error(`Unknown skill "${parameters.name}"`);
			const skill = await loadSkill(reference);
			const details: SkillToolDetails = {
				version: 1,
				tool: "skill",
				status: "loaded",
				requestedName: parameters.name,
				name: skill.name,
				filePath: skill.filePath,
				directory: skill.directory,
				hasSupportingFiles: skill.hasSupportingFiles,
				supportingFiles: skill.supportingFiles,
				supportingFilesTruncated: skill.supportingFilesTruncated,
				frontmatterRemoved: skill.frontmatterRemoved,
				sourceChars: skill.sourceChars,
				loadedChars: skill.content.length,
				loadedTokens: estimateTokens({ role: "user", content: skill.content, timestamp: 0 }),
				instructions: skill.content,
			};
			await pi.sendMessage(
				{
					customType: LOADED_SKILL_CONTEXT_MESSAGE_TYPE,
					content: renderLoadedSkillContext(skill),
					display: false,
					details,
				},
				{ deliverAs: "steer" },
			);
			return {
				content: [{ type: "text", text: `Loaded skill "${skill.name}".` }],
				details,
			};
		},
	};
}
