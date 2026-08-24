export const LOADED_SKILL_CONTEXT_MESSAGE_TYPE = "pi-skills/loaded";

export function renderLoadedSkillContext(skill: { name: string; filePath: string; content: string }): string {
	return [
		"<skill>",
		`<name>${escapeXml(skill.name)}</name>`,
		`<path>${escapeXml(skill.filePath)}</path>`,
		skill.content,
		"</skill>",
	].join("\n");
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
