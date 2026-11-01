import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createGrammarToolInputProperties } from "../src/constrained-sampling.ts";
import { NonRetryableProviderError } from "../src/provider/errors.ts";
import { isRetryableCodexStreamError } from "../src/provider/stream-events.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import { createInitialAssistantMessage } from "../src/provider/types.ts";
import { convertResponsesMessages } from "../src/responses/shared.ts";
import { processResponsesStream } from "../src/responses/stream.ts";
import { createWebRunTool } from "../src/tools/web-run/definition.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

test("request conversion keeps the local web runner as a named function tool", () => {
	const body = buildRequestBody(model, {
		systemPrompt: "You are useful.",
		messages: [{ role: "user", content: "Measure this." }],
		tools: [createWebRunTool()],
	} as never);

	expect(body.tools).toHaveLength(1);
	expect(body.tools?.[0]).toMatchObject({
		type: "function",
		name: "web__run",
		description:
			"Search and inspect the web, images, finance, weather, sports, and time. Use this when current web information or direct source attribution is required.",
	});
});

test("request conversion emits grammar-constrained tools as native freeform tools", () => {
	const tools = ["exec", "apply_patch"].map((name) => ({
		name,
		label: name,
		description: `${name} freeform`,
		parameters: {
			type: "object",
			properties: { input: { type: "string" } },
			required: ["input"],
			additionalProperties: false,
		},
		constrainedSampling: {
			type: "grammar",
			variants: { openai_lark: "start: /[\\s\\S]+/" },
		},
	})) as never;
	const body = buildRequestBody(
		model,
		{
			systemPrompt: "Prompt.",
			messages: [{ role: "user", content: "Work." }],
			tools,
		} as never,
		{
			grammarToolInputProperties: createGrammarToolInputProperties(tools, true),
		},
	);
	expect(body.tools).toEqual([
		expect.objectContaining({ type: "custom", name: "exec", format: expect.objectContaining({ type: "grammar" }) }),
		expect.objectContaining({
			type: "custom",
			name: "apply_patch",
			format: expect.objectContaining({ type: "grammar" }),
		}),
	]);
});

test("request conversion preserves Codex session metadata", () => {
	const body = buildRequestBody(
		model,
		{
			systemPrompt: "Prompt.",
			messages: [{ role: "user", content: "Work." }],
			tools: [],
		} as never,
		{
			sessionId: "session-1",
		},
	);
	expect(body.parallel_tool_calls).toBe(true);
	expect(body.client_metadata).toEqual({
		session_id: "session-1",
		thread_id: "session-1",
		"x-codex-turn-metadata": JSON.stringify({
			session_id: "session-1",
			thread_id: "session-1",
		}),
	});
});

test("native custom tool events become a Pi tool call", async () => {
	const output = createInitialAssistantMessage(model);
	const stream = createAssistantMessageEventStream();
	await processResponsesStream(
		[
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "custom_tool", input: "" },
			},
			{ type: "response.custom_tool_call_input.delta", output_index: 0, delta: "hello" },
			{ type: "response.custom_tool_call_input.done", output_index: 0, input: "hello" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "custom_tool", input: "hello" },
			},
			{
				type: "response.completed",
				response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
			},
		] as never,
		output,
		stream,
		model,
		{
			grammarToolInputProperties: new Map([["custom_tool", "text"]]),
		},
	);

	expect(output.content).toContainEqual({
		type: "toolCall",
		id: "call_1|ctc_1",
		name: "custom_tool",
		arguments: { text: "hello" },
	});
	expect(output.stopReason).toBe("toolUse");
});

type ResponseEvent = Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;

async function* responseEvents(events: readonly ResponseEvent[]): AsyncIterable<ResponseEvent> {
	yield* events;
}

test.each([true, false])("final function arguments are authoritative (streamed: %j)", async (streamed) => {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } as const;
	const events: ResponseEvent[] = streamed
		? [
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"old"}' },
			]
		: [];
	events.push({
		type: "response.output_item.done",
		output_index: 0,
		item: { ...item, arguments: '{"path":"final","offset":7}' },
	});
	const output = createInitialAssistantMessage(model);
	await processResponsesStream(responseEvents(events), output, createAssistantMessageEventStream(), model);
	expect(output.content).toEqual([
		{ type: "toolCall", id: "call_1|fc_1", name: "read_file", arguments: { path: "final", offset: 7 } },
	]);
});

test.each(["null", "[]", "1", '"text"', '{"broken":'])(
	"incomplete or non-object final arguments %s cannot become a tool call",
	async (arguments_) => {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } as const;
		const output = createInitialAssistantMessage(model);
		await expect(
			processResponsesStream(
				responseEvents([
					{ type: "response.output_item.added", output_index: 0, item },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"partial"}' },
					{ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: arguments_ } },
				]),
				output,
				createAssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow("Invalid function call arguments");
		expect(output.content).toEqual([]);
	},
);

test.each([true, false])("completed output items keep their content indexes (added events: %j)", async (added) => {
	type Item = Extract<ResponseEvent, { type: "response.output_item.added" | "response.output_item.done" }>["item"];
	const items: Item[] = [
		{ type: "reasoning", summary: [{ text: "thought" }] },
		{
			type: "message",
			id: "msg_1",
			content: [
				{ type: "output_text", text: "answer" },
				{ type: "refusal", refusal: "refusal" },
			],
		},
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "function", arguments: '{"value":1}' },
		{
			type: "custom_tool_call",
			id: "ctc_1",
			call_id: "call_2",
			name: "custom",
			input: "custom input",
			namespace: "tools",
		},
	];
	const events: ResponseEvent[] = added
		? items.map((item, output_index) => ({ type: "response.output_item.added", output_index, item }))
		: [];
	if (added)
		events.push(
			{ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "thought" },
			{ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "answer" },
			{ type: "response.refusal.delta", output_index: 1, content_index: 1, delta: "refusal" },
		);
	for (let output_index = items.length - 1; output_index >= 0; output_index--) {
		events.push({ type: "response.output_item.done", output_index, item: items[output_index]! });
	}
	const output = createInitialAssistantMessage(model);
	const stream = createAssistantMessageEventStream();
	await processResponsesStream(responseEvents(events), output, stream, model);
	stream.end();
	const starts: number[] = [];
	const ends: number[] = [];
	const deltas: string[] = [];
	for await (const event of stream) {
		if (event.type === "thinking_delta" || event.type === "text_delta") deltas.push(event.delta);
		if (event.type === "thinking_start" || event.type === "text_start" || event.type === "toolcall_start")
			starts.push(event.contentIndex);
		if (event.type === "thinking_end" || event.type === "text_end" || event.type === "toolcall_end")
			ends.push(event.contentIndex);
	}
	expect(deltas).toEqual(added ? ["thought", "answer", "refusal"] : []);
	expect(starts).toEqual([0, 1, 2, 3]);
	expect(ends).toEqual(added ? [3, 2, 1, 0] : [0, 1, 2, 3]);
	const content = added ? output.content : [...output.content].reverse();
	expect(content).toMatchObject([
		{ type: "thinking", thinking: "thought" },
		{ type: "text", text: "answerrefusal" },
		{ type: "toolCall", arguments: { value: 1 } },
		{ type: "toolCall", arguments: { input: "custom input" }, namespace: "tools" },
	]);
});

test("stream failure removes only unfinished tool calls", async () => {
	const output = createInitialAssistantMessage(model);
	const stream = createAssistantMessageEventStream();
	const source = responseEvents([
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "unfinished" },
		},
		{
			type: "response.output_item.done",
			output_index: 1,
			item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: "kept" }] },
		},
		{
			type: "response.output_item.done",
			output_index: 2,
			item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "finished", arguments: "{}" },
		},
		{
			type: "response.output_item.added",
			output_index: 3,
			item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "invalid", arguments: "" },
		},
		{
			type: "response.output_item.done",
			output_index: 3,
			item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "invalid", arguments: "null" },
		},
	]);
	const failure = processResponsesStream(source, output, stream, model);
	await expect(failure).rejects.toBeInstanceOf(NonRetryableProviderError);
	await failure.catch((error: Error) => expect(isRetryableCodexStreamError(error)).toBe(false));
	expect(output.content).toMatchObject([
		{ type: "text", text: "kept" },
		{ type: "toolCall", name: "finished", arguments: {} },
	]);
});

test("stored native custom tool calls replay without current grammar metadata", () => {
	const input = convertResponsesMessages(
		model,
		{
			messages: [
				{
					role: "assistant",
					provider: "openai-codex",
					api: "openai-codex-responses",
					model: "gpt-5.6-sol",
					content: [{ type: "toolCall", id: "call_1|ctc_1", name: "exec", arguments: { code: "return 1" } }],
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "exec",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: 2,
				},
			],
		} as never,
		new Set(["openai-codex"]),
	);

	expect(input).toEqual([
		{
			type: "custom_tool_call",
			id: "ctc_1",
			call_id: "call_1",
			name: "exec",
			input: "return 1",
		},
		{ type: "custom_tool_call_output", call_id: "call_1", output: "1" },
	]);
});

test("native web search items replay as Responses input", () => {
	const input = convertResponsesMessages(
		model,
		{
			messages: [
				{
					role: "assistant",
					provider: "openai-codex",
					api: "openai-codex-responses",
					model: "gpt-5.6-sol",
					stopReason: "stop",
					timestamp: 1,
					content: [
						{
							type: "web_search_call",
							item: {
								type: "web_search_call",
								id: "ws_1",
								status: "completed",
								action: { type: "search", query: "latest" },
							},
						},
					],
				},
			],
		} as never,
		new Set(["openai-codex"]),
	);

	expect(input).toEqual([
		{
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			action: { type: "search", query: "latest" },
		},
	]);
});

test("a loaded skill follows its paired tool output as contextual user content", () => {
	const messages = convertToLlm([
		{
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			timestamp: 1,
			content: [{ type: "toolCall", id: "call_1|fc_1", name: "skill", arguments: { name: "writing-for-agents" } }],
		},
		{
			role: "toolResult",
			toolCallId: "call_1|fc_1",
			toolName: "skill",
			content: [{ type: "text", text: 'Loaded skill "writing-for-agents".' }],
			isError: false,
			timestamp: 2,
		},
		{
			role: "custom",
			customType: "pi-skills/loaded",
			content:
				"<skill>\n<name>writing-for-agents</name>\n<path>/skills/writing-for-agents/SKILL.md</path>\nWrite clearly.\n</skill>",
			display: true,
			timestamp: 2,
		},
	] as never);
	const input = convertResponsesMessages(model, { messages } as never, new Set(["openai-codex"]));

	expect(input.map((item) => item.type ?? item.role)).toEqual(["function_call", "function_call_output", "user"]);
	expect(JSON.stringify(input[2])).toContain("<skill>");
});

test("serializes Code Mode audio as a Responses tool output", () => {
	const messages = [
		{
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.6-sol",
			stopReason: "toolUse",
			timestamp: 1,
			content: [{ type: "toolCall", id: "call_audio|fc_audio", name: "exec", arguments: { code: "audio(x)" } }],
		},
		{
			role: "toolResult",
			toolCallId: "call_audio|fc_audio",
			toolName: "exec",
			content: [{ type: "audio", data: "YQ==", mimeType: "audio/wav" }],
			isError: false,
			timestamp: 2,
		},
	];

	const input = convertResponsesMessages(model, { messages } as never, new Set(["openai-codex"]));
	expect(input[1]).toEqual({
		type: "function_call_output",
		call_id: "call_audio",
		output: [{ type: "input_audio", audio_url: "data:audio/wav;base64,YQ==" }],
	});
});

test("ordinary Codex function tools keep optional arguments optional", () => {
	const parameters = {
		type: "object",
		properties: { action: { type: "string" }, name: { type: "string" } },
		required: ["action"],
	};
	const body = buildRequestBody(model, {
		messages: [],
		tools: [{ name: "notebook__control", description: "Control notebook", parameters }],
	});
	expect(body.tools?.[0]).toMatchObject({ type: "function", strict: false, parameters });
});

test("transcript prompt and tool deltas retain their position and honor removals", () => {
	const nativeModel = { ...model, compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } };
	const search = { name: "tool_search", description: "Find tools", parameters: { type: "object" as const } };
	const loaded = { name: "weather", description: "Weather", parameters: { type: "object" as const } };
	const messages = [
		{ role: "system" as const, content: "Base instructions", toolsAdded: [search], timestamp: 0 },
		{ role: "user" as const, content: "Find the weather", timestamp: 1 },
		{ role: "system" as const, content: "Use metric units", toolsAdded: [loaded], timestamp: 2 },
	];
	const body = buildRequestBody(nativeModel, { messages });
	expect(body.instructions).toBe("Base instructions");
	expect(body.tools).toMatchObject([{ name: "tool_search" }]);
	expect(body.input).toMatchObject([
		{ role: "user" },
		{ type: "additional_tools", tools: [{ name: "weather" }] },
		{ role: "developer", content: "Use metric units" },
	]);
	const removed = buildRequestBody(nativeModel, {
		messages: [...messages, { role: "system", content: "", toolsRemoved: [{ name: "weather" }], timestamp: 3 }],
	});
	expect(removed.tools).toMatchObject([{ name: "tool_search" }]);
	expect(
		removed.input.some(
			(item) => item !== null && typeof item === "object" && "type" in item && item.type === "additional_tools",
		),
	).toBe(false);
});

test.each(["off", "none"])("explicit reasoning %s uses the model's Off mapping", (effort) => {
	const options = effort === "off" ? {} : { reasoningEffort: "none" as const };
	expect(
		buildRequestBody({ ...model, thinkingLevelMap: { off: "none" } }, { messages: [] }, options).reasoning,
	).toMatchObject({ effort: "none" });
	const unsupported = buildRequestBody(
		{ ...model, thinkingLevelMap: { off: null } },
		{ messages: [] },
		options,
	).reasoning;
	expect(unsupported).toBeUndefined();
});
