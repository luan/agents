import { expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createGrammarToolInputProperties } from "../src/constrained-sampling.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import { createInitialAssistantMessage } from "../src/provider/types.ts";
import { convertResponsesMessages } from "../src/responses/shared.ts";
import { processResponsesStream } from "../src/responses/stream.ts";
import { createWebRunTool } from "../src/tools/web-run/definition.ts";

const model = {
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
} as never;

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

test("request conversion identifies the Code Mode hierarchy to Codex", () => {
	const body = buildRequestBody(
		model,
		{
			systemPrompt: "Prompt.",
			messages: [{ role: "user", content: "Work." }],
			tools: [],
		} as never,
		{
			sessionId: "session-1",
			codeModeToolNames: ["exec_command", "apply_patch", "exec_command"],
		},
	);
	expect(body.parallel_tool_calls).toBe(false);
	expect(body.client_metadata).toEqual({
		session_id: "session-1",
		thread_id: "session-1",
		"x-codex-turn-metadata": JSON.stringify({
			session_id: "session-1",
			thread_id: "session-1",
			code_mode_tool_names: ["exec_command", "apply_patch"],
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
