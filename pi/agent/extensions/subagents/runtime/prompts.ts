/**
 * prompts.ts — System prompt builder for agents.
 */

import { buildCavemanPrompt, resolveCavemanMode } from "../../system-prompt/caveman.ts";
import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
	/** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
	memoryBlock?: string;
	/** Preloaded skill contents to inject. */
	skillBlocks?: { name: string; content: string }[];
	/** The immutable task this subagent was spawned to perform. */
	delegatedTask?: { taskName: string; message: string };
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + Caveman style + config.systemPrompt
 * - "append" mode: env header + parent system prompt + sub-agent context + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (memory, preloaded skills).
 */
export function buildAgentPrompt(
	config: AgentConfig,
	cwd: string,
	env: EnvInfo,
	parentSystemPrompt?: string,
	extras?: PromptExtras,
): string {
	const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

	// Build optional extras suffix
	const extraSections: string[] = [];
	if (extras?.memoryBlock) {
		extraSections.push(extras.memoryBlock);
	}
	if (extras?.skillBlocks?.length) {
		for (const skill of extras.skillBlocks) {
			extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
		}
	}
	if (extras?.delegatedTask) {
		extraSections.push(formatDelegatedTask(extras.delegatedTask));
	}
	const extrasSuffix = extraSections.length > 0 ? `\n\n${extraSections.join("\n")}` : "";

	if (config.promptMode === "append") {
		const identity = parentSystemPrompt || genericBase;
		const cavemanPrompt = extractCavemanPrompt(identity) ? undefined : configuredCavemanPrompt(cwd);

		const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

		const customSection = config.systemPrompt?.trim()
			? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
			: "";
		const cavemanSection = cavemanPrompt ? `\n\n${cavemanPrompt}` : "";

		return (
			envBlock +
			"\n\n<inherited_system_prompt>\n" +
			identity +
			cavemanSection +
			"\n</inherited_system_prompt>\n\n" +
			bridge +
			customSection +
			extrasSuffix
		);
	}

	// "replace" mode — env header + Caveman style + config system prompt
	const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task.

${envBlock}`;
	const cavemanPrompt = configuredCavemanPrompt(cwd, parentSystemPrompt);
	const sections = [cavemanPrompt, config.systemPrompt].filter((section): section is string =>
		Boolean(section?.trim()),
	);

	return `${replaceHeader}\n\n${sections.join("\n\n")}${extrasSuffix}`;
}

function configuredCavemanPrompt(cwd: string, parentSystemPrompt?: string): string | undefined {
	const mode = resolveCavemanMode(cwd);
	return extractCavemanPrompt(parentSystemPrompt) ?? (mode ? buildCavemanPrompt(mode) : undefined);
}

function extractCavemanPrompt(prompt: string | undefined): string | undefined {
	const match = prompt?.match(/# Caveman \((?:lite|full|ultra)\)[\s\S]*?(?=\n(?:# |<)|$)/);
	return match?.[0]?.trim();
}
/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;

function formatDelegatedTask(task: { taskName: string; message: string }): string {
	return `<delegated_task>
This is the task you were spawned to complete. Treat it as authoritative even after conversation compaction.

<task_name>
${task.taskName}
</task_name>

<task_message>
${task.message}
</task_message>
</delegated_task>`;
}
