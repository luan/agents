import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	buildRemoteCompactionV2Window,
	canonicalCompactionOutput,
	normalizeRemoteCompactionV2PromptInput,
} from "../src/compaction/remote-v2-history.ts";
import { executeRemoteCompactionV2, withRemoteCompactionV2Feature } from "../src/compaction/remote-v2-client.ts";
import {
	COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE,
	resolveNativeCompactionRequestBudget,
	shrinkNativeCompactionRequestForEndpoint,
} from "../src/compaction/request-shrink.ts";
import type { NativeCompactionRuntime } from "../src/compaction/runtime.ts";
import {
	createNativeCompactionDetails,
	isNativeCompactionDetails,
	NATIVE_COMPACTION_STRATEGY,
} from "../src/compaction/types.ts";
import type { OpenAICodexStreamOptions, ResponsesBody } from "../src/provider/types.ts";
import { clearCanonicalSessions, recordCanonicalSessionResponse } from "../src/provider/session-continuity.ts";

const model = {
	id: "test-model",
	name: "Test model",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 20_000,
} as Model<Api>;

function assistantMessage(responseId = "resp_compact"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: model.id,
		usage: {
			input: 20,
			output: 2,
			cacheRead: 5,
			cacheWrite: 1,
			totalTokens: 28,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		responseId,
	};
}

type FakeStreamPlan = {
	failures?: number;
	status?: number;
	outputItems?: unknown[];
	requestBody?: Partial<ResponsesBody>;
};

function fakeRegistry(plan: FakeStreamPlan, attempts: { count: number; payloads: unknown[] }): ModelRegistry {
	const streamSimple = async function* (
		_streamModel: Model<Api>,
		_context: Context,
		streamOptions?: SimpleStreamOptions,
	): AsyncGenerator<unknown> {
		attempts.count++;
		const options = streamOptions as OpenAICodexStreamOptions | undefined;
		await options?.onResponse?.({ status: plan.status ?? 200, headers: {} }, model);
		const requestBody: ResponsesBody = {
			model: model.id,
			store: false,
			stream: true,
			instructions: "compact",
			input: [],
			text: { verbosity: "low" },
			include: ["reasoning.encrypted_content"],
			tool_choice: "auto",
			parallel_tool_calls: true,
			...plan.requestBody,
		};
		attempts.payloads.push(await options?.onPayload?.(requestBody, model));
		if (attempts.count <= (plan.failures ?? 0)) {
			yield {
				type: "error",
				error: { ...assistantMessage(), stopReason: "error", errorMessage: "temporary transport error" },
			};
			return;
		}
		for (const item of plan.outputItems ?? [{ type: "compaction", encrypted_content: "opaque" }]) {
			options?.onOutputItemDone?.(item);
		}
		yield { type: "done", reason: "stop", message: assistantMessage() };
	};
	return {
		getRegisteredNativeProvider: () => ({ streamSimple }) as never,
		getRegisteredProviderConfig: () => undefined,
	} as unknown as ModelRegistry;
}

function runtime(hooks?: NativeCompactionRuntime["hooks"]): NativeCompactionRuntime {
	const jwtPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		}),
	).toString("base64url");
	return {
		provider: "openai-codex",
		api: "openai-codex-responses",
		hooks,
		model: model.id,
		baseUrl: model.baseUrl,
		apiKey: `header.${jwtPayload}.signature`,
		currentModel: model,
	};
}

describe("remote-v2 history", () => {
	test("accepts only canonical encrypted compaction output", () => {
		expect(
			canonicalCompactionOutput({
				type: "compaction_summary",
				id: "cmp_1",
				encrypted_content: "encrypted",
				internal_chat_message_metadata_passthrough: { turn_id: "turn_1", ignored: true },
			}),
		).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "encrypted",
			internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
		});
		expect(canonicalCompactionOutput({ type: "compaction", encrypted_content: " " })).toBeUndefined();
		expect(
			canonicalCompactionOutput({
				type: "compaction",
				encrypted_content: "encrypted",
				internal_chat_message_metadata_passthrough: { turn_id: 3 },
			}),
		).toBeUndefined();
	});

	test("normalizes tool history before remote compaction", () => {
		const input = [
			{ type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" },
			{ type: "function_call_output", call_id: "orphan", output: "drop" },
		];
		expect(normalizeRemoteCompactionV2PromptInput(input)).toEqual([
			input[0],
			{ type: "function_call_output", call_id: "call_1", output: "aborted" },
		]);
	});

	test("filters injected context but retains the real user request", () => {
		const compaction = { type: "compaction", encrypted_content: "opaque" };
		const window = buildRemoteCompactionV2Window(
			[
				{
					role: "user",
					content: [
						{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>" },
						{ type: "input_text", text: "Implement the parser." },
					],
				},
				{
					role: "user",
					content: [{ type: "input_text", text: "<skill>\n<name>writing-for-agents</name>\nBody.\n</skill>" }],
				},
			],
			compaction,
		);
		expect(window).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Implement the parser." }] },
			compaction,
		]);
	});

	test("retains the newest real user message when the budget is exhausted", () => {
		const compaction = { type: "compaction", encrypted_content: "opaque" };
		const window = buildRemoteCompactionV2Window(
			[
				{ role: "user", content: [{ type: "input_text", text: "old message" }] },
				{ role: "user", content: [{ type: "input_text", text: "new message" }] },
			],
			compaction,
			0,
		);
		expect(window).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new message" }] },
			compaction,
		]);
	});
});

describe("remote-v2 request shrinking", () => {
	test("uses the model context budget", () => {
		expect(
			resolveNativeCompactionRequestBudget({
				contextWindow: 200_000,
			}),
		).toBe(190_000);
	});

	test("truncates trailing tool outputs until the request fits", async () => {
		const result = await shrinkNativeCompactionRequestForEndpoint(
			{
				model: model.id,
				instructions: "compact",
				input: [
					{ type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" },
					{ type: "function_call_output", call_id: "call_1", output: "x".repeat(4_000) },
				],
			},
			{ budgetTokens: 100, tokensBefore: 1_000 },
		);
		expect(result.rewrittenOutputs).toBe(1);
		expect((result.request.input[1] as Record<string, unknown>).output).toBe(COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE);
	});
});

describe("remote-v2 persistence", () => {
	test("writes only the remote-v2 strategy and rejects the historical strategy", () => {
		const details = createNativeCompactionDetails({
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
			compactResponseId: "resp_1",
			createdAt: "2026-08-17T00:00:00.000Z",
			usage: { inputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 1, outputTokens: 2 },
		});
		expect(details.strategy).toBe(NATIVE_COMPACTION_STRATEGY);
		expect(isNativeCompactionDetails(details)).toBeTrue();
		expect(isNativeCompactionDetails({ ...details, strategy: "openai-native-compact-v2" })).toBeFalse();
	});
});

describe("remote-v2 client", () => {
	test("merges the exact remote-v2 feature header case-insensitively", () => {
		expect(
			withRemoteCompactionV2Feature({
				"X-Codex-Beta-Features": "existing, REMOTE_COMPACTION_V2",
				"x-codex-beta-features": "second,existing",
				"x-test": "kept",
			}),
		).toEqual({
			"x-test": "kept",
			"x-codex-beta-features": "existing,second,remote_compaction_v2",
		});
	});

	test("passes the exact compacted replay input to prewarm", async () => {
		const attempts = { count: 0, payloads: [] as unknown[] };
		const calls: string[] = [];
		let prewarmBody: Record<string, unknown> | undefined;
		const result = await executeRemoteCompactionV2({
			runtime: runtime({
				resetTransportAfterCompaction: (sessionId) => {
					calls.push(`reset:${sessionId}`);
				},
				startCompactionPrewarm: ({ sessionId, body }) => {
					calls.push(`prewarm:${sessionId}`);
					prewarmBody = body;
				},
			}),
			modelRegistry: fakeRegistry({}, attempts),
			context: { systemPrompt: "system", messages: [] },
			promptInput: [{ role: "user", content: [{ type: "input_text", text: "request" }] }],
			requestOptions: {},
			tokensBefore: 1_000,
			sessionId: "session-1",
		});
		expect(result.ok).toBeTrue();
		expect(attempts.count).toBe(1);
		expect(calls).toEqual(["reset:session-1", "prewarm:session-1"]);
		const payload = attempts.payloads.at(-1) as ResponsesBody;
		expect(payload.input.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(prewarmBody?.input).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "request" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		]);
		expect(prewarmBody?.input).toEqual(result.ok ? result.replayBody.input : undefined);
	});

	test("uses the current prompt envelope and tools instead of stale canonical request controls", async () => {
		clearCanonicalSessions();
		const sessionId = "current-envelope";
		const identity = { url: "wss://chatgpt.com/backend-api/codex/responses", accountId: "account-1" };
		recordCanonicalSessionResponse({
			sessionId,
			...identity,
			requestBody: {
				model: model.id,
				store: false,
				stream: true,
				instructions: "stale instructions",
				input: [{ role: "user", content: "stale input" }],
				tools: [{ type: "function", name: "stale_tool" }],
				text: { verbosity: "low" },
				include: ["reasoning.encrypted_content"],
				tool_choice: "auto",
				parallel_tool_calls: true,
			},
			responseItems: [],
		});
		const attempts = { count: 0, payloads: [] as unknown[] };
		await executeRemoteCompactionV2({
			runtime: runtime(),
			modelRegistry: fakeRegistry(
				{
					requestBody: {
						instructions: "current instructions",
						tools: [{ type: "function", name: "current_tool" }],
					},
				},
				attempts,
			),
			context: { systemPrompt: "current instructions", messages: [] },
			promptInput: [{ role: "user", content: [{ type: "input_text", text: "current input" }] }],
			requestOptions: {},
			tokensBefore: 1_000,
			sessionId,
		});
		const payload = attempts.payloads[0] as ResponsesBody;
		expect(payload.instructions).toBe("current instructions");
		expect(payload.tools).toEqual([{ type: "function", name: "current_tool" }]);
		expect(JSON.stringify(payload.input)).toContain("current input");
		expect(JSON.stringify(payload)).not.toContain("stale input");
		expect(JSON.stringify(payload)).not.toContain("stale_tool");
		clearCanonicalSessions();
	});

	test("does not retry invalid output or invoke success hooks", async () => {
		const attempts = { count: 0, payloads: [] as unknown[] };
		let reset = false;
		const result = await executeRemoteCompactionV2({
			runtime: runtime({
				resetTransportAfterCompaction: () => {
					reset = true;
				},
			}),
			modelRegistry: fakeRegistry({ outputItems: [] }, attempts),
			context: { systemPrompt: "system", messages: [] },
			promptInput: [{ role: "user", content: [{ type: "input_text", text: "request" }] }],
			requestOptions: {},
			tokensBefore: 1_000,
			sessionId: "session-2",
		});
		expect(result).toMatchObject({ ok: false, reason: "invalid-output" });
		expect(attempts.count).toBe(1);
		expect(reset).toBeFalse();
	});

	test("does not retry authentication failures", async () => {
		const attempts = { count: 0, payloads: [] as unknown[] };
		const result = await executeRemoteCompactionV2({
			runtime: runtime(),
			modelRegistry: fakeRegistry({ failures: 1, status: 401 }, attempts),
			context: { systemPrompt: "system", messages: [] },
			promptInput: [{ role: "user", content: [{ type: "input_text", text: "request" }] }],
			requestOptions: {},
			tokensBefore: 1_000,
			sessionId: "session-3",
		});
		expect(result).toMatchObject({ ok: false, reason: "stream-error", status: 401 });
		expect(attempts.count).toBe(1);
	});
});
