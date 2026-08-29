const GENERIC_BASE = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
Do what has been asked; nothing more, nothing less.`;

export interface SubagentPromptContext {
	agentPath: string;
	maxConcurrency: number;
	maxDepth: number;
	completionDelivery?: "none" | "parent";
}

const ROOT_CONTEXT = /\n*<root_agent_context>[\s\S]*?<\/root_agent_context>\n*/g;
const CHILD_CONTEXT = /\n*<sub_agent_context>[\s\S]*?<\/sub_agent_context>\n*/g;

/** Replace the inherited agent identity instead of accumulating one layer per nesting level. */
export function buildAgentPrompt(parentSystemPrompt?: string, context?: SubagentPromptContext): string {
	const inherited = (parentSystemPrompt || GENERIC_BASE)
		.replace(ROOT_CONTEXT, "\n")
		.replace(CHILD_CONTEXT, "\n")
		.trim();
	if (!context) return inherited;
	const deliveryGuidance =
		context.completionDelivery === "none"
			? "- Your responses remain in this session transcript. They are not delivered into the parent session."
			: "- Your final response is delivered automatically to your direct parent as a hidden FINAL_ANSWER mailbox message. Do not send_message the same final response.";
	const identity =
		context.completionDelivery === "none"
			? `You are \`${context.agentPath}\`, an interactive non-root session.`
			: `You are \`${context.agentPath}\`, a non-root agent assigned one concrete task.`;
	const taskGuidance =
		context.completionDelivery === "none"
			? "- Respond to each prompt in this continuing side session."
			: "- Complete only the assigned task.";
	const childContext = `<sub_agent_context>
${identity}
There are ${context.maxConcurrency} concurrent agent slots including the root.
Subagent nesting is limited to depth ${context.maxDepth}.
${taskGuidance}
- Use the installed tools and skills available in this child session.
${deliveryGuidance}
- Use send_message only for an interim MESSAGE that the parent needs before you finish.
- wait_agent is status-only. Child final responses arrive independently through the mailbox.
- Relative collaboration targets name your direct children. Canonical /root/... paths address agents elsewhere in the tree.
- Spawn another agent only for a concrete, bounded subtask that can run independently alongside useful local work.
</sub_agent_context>`;
	return `${inherited}\n\n${childContext}`;
}
