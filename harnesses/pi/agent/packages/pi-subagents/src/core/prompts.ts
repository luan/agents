const GENERIC_BASE = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
Do what has been asked; nothing more, nothing less.`;

export interface SubagentPromptContext {
	agentPath: string;
	maxConcurrency: number;
	maxDepth: number;
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
	const childContext = `<sub_agent_context>
You are \`${context.agentPath}\`, a non-root agent assigned one concrete task.
There are ${context.maxConcurrency} concurrent agent slots including the root.
Subagent nesting is limited to depth ${context.maxDepth}.
- Complete only the assigned task.
- Use the installed tools and skills available in this child session.
- Send useful results to the parent.
- Spawn another agent only for a concrete, bounded subtask that can run independently alongside useful local work.
</sub_agent_context>`;
	return `${inherited}\n\n${childContext}`;
}
