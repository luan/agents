import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const DEFAULT_REPEAT_LIMIT = 3;

function outcomeKey(tool: string, args: object, outcome: string): string {
	return JSON.stringify([tool, JSON.stringify(args), outcome]);
}

export function createRepeatBreaker(limit = DEFAULT_REPEAT_LIMIT) {
	const bySession = new Map<string, Map<string, number>>();
	return {
		observe(session: string, tool: string, args: object, outcome: string): string | undefined {
			const key = outcomeKey(tool, args, outcome);
			let counts = bySession.get(session);
			if (!counts) {
				counts = new Map();
				bySession.set(session, counts);
			}
			const count = (counts.get(key) ?? 0) + 1;
			if (count === 1) counts.clear();
			counts.set(key, count);
			if (count < limit) return undefined;
			return `This identical ${tool} call has now produced the same outcome ${count} times and will keep doing so. Stop calling ${tool} with these arguments.`;
		},
	};
}

type RepeatBreaker = ReturnType<typeof createRepeatBreaker>;

export function withRepeatBreaker<TParameters extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParameters, TDetails, TState>,
	breaker: RepeatBreaker,
): ToolDefinition<TParameters, TDetails, TState> {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		async execute(toolCallId, parameters, signal, onUpdate, context) {
			try {
				const result = await execute(toolCallId, parameters, signal, onUpdate, context);
				const outcome = result.content.find((item) => item.type === "text")?.text ?? "";
				const note = breaker.observe(context.sessionManager.getSessionId(), tool.name, parameters, outcome);
				return note ? appendOutcomeNote(result, note) : result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const note = breaker.observe(context.sessionManager.getSessionId(), tool.name, parameters, message);
				throw note ? new Error(`${message}\n${note}`) : error;
			}
		},
	};
}

function appendOutcomeNote<TDetails>(result: AgentToolResult<TDetails>, note: string): AgentToolResult<TDetails> {
	const content = result.content.map((item) => ({ ...item }));
	const index = content.findIndex((item) => item.type === "text");
	if (index < 0) content.push({ type: "text", text: note });
	else {
		const item = content[index];
		if (item?.type === "text") content[index] = { ...item, text: `${item.text}\n\n${note}` };
	}
	return { ...result, content };
}
