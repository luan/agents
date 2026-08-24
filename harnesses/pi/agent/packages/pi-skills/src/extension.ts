import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ComponentStack } from "pi-libtui";
import { registerSkillCodeModeAdapter } from "./code-mode-adapter.ts";
import { getSkillsSettings, registerSkillsXSettings } from "./contributions/xsettings.ts";
import { registerSkillsPromptContribution } from "./prompt.ts";
import { createSkillTool } from "./tools/skill/definition.ts";
import { LOADED_SKILL_CONTEXT_MESSAGE_TYPE } from "./loaded-skill-context.ts";

export default function skillsExtension(pi: ExtensionAPI): void {
	const disposeXSettings = registerSkillsXSettings();
	const disposePrompt = registerSkillsPromptContribution(getSkillsSettings);
	const tool = createSkillTool(pi);
	pi.registerTool(tool);
	// Historical sessions may contain displayable copies; the tool row owns their presentation.
	pi.registerMessageRenderer(LOADED_SKILL_CONTEXT_MESSAGE_TYPE, () => new ComponentStack());
	const disposeCodeModeAdapter = registerSkillCodeModeAdapter(tool);
	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload" || event.reason === "quit") {
			disposePrompt();
			disposeCodeModeAdapter();
			disposeXSettings();
		}
	});
}
