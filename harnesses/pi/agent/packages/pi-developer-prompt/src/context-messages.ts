export const AGENTS_CONTEXT_MESSAGE_TYPE = "pi-developer-prompt/agents-md";
const LEGACY_AGENTS_CONTEXT_MESSAGE_TYPES = ["pi-system-prompt/agents-md"];
export const AGENTS_CONTEXT_MESSAGE_ID = "agents-md";

interface ContextFile {
	path: string;
	content: string;
}

interface AgentMessageLike {
	role?: string;
	customType?: string;
}

export interface AgentsContextMessage {
	role: "custom";
	customType: typeof AGENTS_CONTEXT_MESSAGE_TYPE;
	content: string;
	display: false;
	timestamp: 0;
}

export function renderAgentsContext(
	contextFiles: readonly ContextFile[],
	cwd: string,
	agentDir = getAgentDir(),
): string | undefined {
	const files = contextFiles.filter((file) => file.content.trim().length > 0);
	if (files.length === 0) return undefined;
	const hasGlobalInstructions = resolve(dirname(files[0]!.path)) === resolve(agentDir);
	const codexBody =
		hasGlobalInstructions && files.length > 1
			? `${files[0]!.content}\n\n--- project-doc ---\n\n${files
					.slice(1)
					.map((file) => file.content)
					.join("\n\n")}`
			: files.map((file) => file.content).join("\n\n");
	return `# AGENTS.md instructions for ${cwd.replaceAll("\\", "/")}\n\n<INSTRUCTIONS>\n${codexBody}\n</INSTRUCTIONS>`;
}

export function injectAgentsContext<T extends AgentMessageLike>(
	messages: readonly T[],
	content: string | undefined,
): (T | AgentsContextMessage)[] | undefined {
	const filtered = messages.filter(
		(message) =>
			message.role !== "custom" ||
			(message.customType !== AGENTS_CONTEXT_MESSAGE_TYPE &&
				!LEGACY_AGENTS_CONTEXT_MESSAGE_TYPES.includes(message.customType as string)),
	);
	if (!content) return filtered.length === messages.length ? undefined : filtered;
	return [
		{
			role: "custom",
			customType: AGENTS_CONTEXT_MESSAGE_TYPE,
			content,
			display: false,
			timestamp: 0,
		},
		...filtered,
	];
}
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
