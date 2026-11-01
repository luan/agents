import { expect, test } from "bun:test";
import { getCodexModels } from "../src/provider/models.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import { CodexProviderRuntime, createCodexPrewarmIdentity } from "../src/provider/runtime.ts";
import type { ResponsesBody } from "../src/provider/types.ts";

const baseBody: ResponsesBody = {
	model: "gpt-5.6-sol",
	store: false,
	stream: true,
	instructions: "Use the final Pi system prompt.",
	input: [{ role: "user", content: "Inspect the repository." }],
	text: { verbosity: "medium" },
	include: ["reasoning.encrypted_content"],
	tool_choice: "auto",
	parallel_tool_calls: true,
	service_tier: "priority",
	tools: [{ type: "function", name: "read_file" }],
	reasoning: { effort: "high", summary: "auto" },
	client_metadata: { source: "pi" },
};

function headers(input: { requestId?: string; routingHint?: string } = {}): Headers {
	return new Headers({
		authorization: "Bearer secret",
		"openai-beta": "responses_websockets=2026-02-06",
		originator: "codex_cli_rs",
		"session-id": input.requestId ?? "request-1",
		"thread-id": input.requestId ?? "request-1",
		"x-client-request-id": input.requestId ?? "request-1",
		"x-codex-routing-hint": input.routingHint ?? "model=gpt-5.6-sol;tier=priority",
	});
}

function identity(overrides: { url?: string; headers?: Headers; body?: ResponsesBody } = {}): string {
	return createCodexPrewarmIdentity({
		url: overrides.url ?? "wss://chatgpt.com/backend-api/codex/responses",
		accountId: "account-1",
		headers: overrides.headers ?? headers(),
		body: overrides.body ?? baseBody,
	});
}

test("model metadata carries Codex image-detail capability", () => {
	const models = getCodexModels();
	expect(models.find((model) => model.id === "gpt-5.6-luna")?.compat?.supportsImageDetailOriginal).toBe(true);
	expect(
		models.find((model) => model.id === "gpt-5.3-codex-spark")?.compat?.supportsImageDetailOriginal,
	).toBeUndefined();
});

test.each([
	["minimal", "low"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["xhigh", "xhigh"],
	["max", "max"],
] as const)("Astra sends %s reasoning as %s", (reasoning, effort) => {
	const model = getCodexModels().find((candidate) => candidate.id === "gpt-6-astra");
	if (!model) throw new Error("Astra is not registered");
	expect(model).toMatchObject({
		provider: "openai-codex",
		api: "openai-codex-responses",
		input: ["text", "image"],
		contextWindow: 272_000,
		compat: {
			supportsOpenAIGrammarTools: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsImageDetailOriginal: true,
		},
	});
	const body = buildRequestBody(model, { messages: [] }, { reasoning });
	expect(body.model).toBe("gpt-6-astra");
	expect(body.reasoning?.effort).toBe(effort);
});

test("prewarm identity covers the full semantic request", () => {
	const reorderedBody: ResponsesBody = {
		parallel_tool_calls: true,
		tool_choice: "auto",
		include: ["reasoning.encrypted_content"],
		text: { verbosity: "medium" },
		input: [{ content: "Inspect the repository.", role: "user" }],
		instructions: "Use the final Pi system prompt.",
		stream: true,
		store: false,
		model: "gpt-5.6-sol",
		client_metadata: { source: "pi" },
		reasoning: { summary: "auto", effort: "high" },
		tools: [{ name: "read_file", type: "function" }],
		service_tier: "priority",
	};

	expect(identity({ body: reorderedBody, headers: headers({ requestId: "request-2" }) })).toBe(identity());
	expect(identity({ url: "wss://example.com/codex/responses" })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, model: "gpt-5.6-terra" } })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, instructions: "A different final prompt." } })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, tools: [{ type: "function", name: "exec_command" }] } })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, reasoning: { effort: "medium", summary: "auto" } } })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, service_tier: "default" } })).not.toBe(identity());
	expect(identity({ body: { ...baseBody, input: [{ role: "user", content: "A new request." }] } })).not.toBe(
		identity(),
	);
	expect(identity({ headers: headers({ routingHint: "model=gpt-5.6-sol;tier=default" }) })).not.toBe(identity());
});

test("compaction prewarm sends the exact replay body and caches only that identity", async () => {
	const bodies: ResponsesBody[] = [];
	const runtime = new CodexProviderRuntime({
		prewarmTransport: async (_url, body) => {
			bodies.push(body);
		},
	});
	const model = await initializeSession(runtime, "prewarm-identity");

	const body: ResponsesBody = {
		...baseBody,
		input: [
			{ role: "user", content: [{ type: "input_text", text: "Retained message" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		],
	};
	await runtime.startCompactionPrewarm({ sessionId: "prewarm-identity", model, body });
	await runtime.startCompactionPrewarm({ sessionId: "prewarm-identity", model, body });

	expect(bodies).toEqual([body]);
	expect(bodies[0]).toBe(body);
	expect(bodies[0]).not.toHaveProperty("compaction_trigger");

	const changedBody = { ...body, instructions: "A new final Pi system prompt." };
	await runtime.startCompactionPrewarm({ sessionId: "prewarm-identity", model, body: changedBody });
	expect(bodies).toEqual([body, changedBody]);
});

async function initializeSession(runtime: CodexProviderRuntime, sessionId: string) {
	const model = getCodexModels()[0];
	if (!model) throw new Error("No registered models");

	const result = await runtime
		.stream(
			model,
			{ messages: [] },
			{
				sessionId,
				apiKey: testApiKey(),
				transport: "sse",
				fetch: Object.assign(
					async () =>
						new Response('data: {"type":"response.completed","response":{"id":"test","status":"completed"}}\n\n'),
					{ preconnect() {} },
				),
			},
		)
		.result();
	expect(result.stopReason).toBe("stop");
	return model;
}

test.each(["superseded", "shutdown"] as const)("a %s prewarm cannot overwrite later session state", async (reason) => {
	const pending: Array<{
		signal: AbortSignal | undefined;
		completion: ReturnType<typeof Promise.withResolvers<void>>;
	}> = [];
	const runtime = new CodexProviderRuntime({
		prewarmTransport: async (_url, _body, _headers, _account, options) => {
			const completion = Promise.withResolvers<void>();
			pending.push({ signal: options?.signal, completion });
			await completion.promise;
		},
	});
	const sessionId = `prewarm-${reason}`;
	const model = await initializeSession(runtime, sessionId);
	try {
		const first = runtime.startCompactionPrewarm({ sessionId, model, body: baseBody });
		expect(pending).toHaveLength(1);
		const changedBody = { ...baseBody, instructions: "new request" };
		if (reason === "superseded") {
			const second = runtime.startCompactionPrewarm({ sessionId, model, body: changedBody });
			expect(pending).toHaveLength(2);
			pending[1]!.completion.resolve();
			await second;
		} else runtime.shutdown();
		expect(pending[0]!.signal?.aborted).toBe(true);
		pending[0]!.completion.resolve();
		await first;
		await runtime.startCompactionPrewarm({ sessionId, model, body: changedBody });
		expect(pending).toHaveLength(reason === "superseded" ? 2 : 1);
	} finally {
		runtime.shutdown();
		for (const request of pending) request.completion.resolve();
	}
});

function testApiKey(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
	).toString("base64url");
	return `test.${payload}.test`;
}

test.each(["session", "runtime", "unscoped"] as const)("%s shutdown aborts active SSE requests", async (scope) => {
	const runtime = new CodexProviderRuntime();
	const model = getCodexModels()[0];
	if (!model) throw new Error("No registered models");
	const sessionId = `shutdown-${scope}`;
	const userAbort = new AbortController();
	const started = Promise.withResolvers<AbortSignal>();
	const result = runtime
		.stream(
			model,
			{ messages: [] },
			{
				sessionId: scope === "unscoped" ? undefined : sessionId,
				apiKey: testApiKey(),
				transport: "sse",
				signal: userAbort.signal,
				fetch: Object.assign(
					async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
						const signal = init?.signal;
						if (!signal) throw new Error("Missing request cancellation");
						started.resolve(signal);
						return new Promise<Response>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					},
					{ preconnect() {} },
				),
			},
		)
		.result();
	try {
		const signal = await started.promise;
		if (scope === "session")
			runtime.shutdownSession({
				sessionManager: {
					getSessionId: () => sessionId,
					getSessionFile: () => undefined,
				},
			});
		else runtime.shutdown();
		expect(signal.aborted).toBe(true);
		expect((await result).stopReason).toBe("aborted");
	} finally {
		userAbort.abort();
		await result;
		runtime.shutdown();
	}
});

test("session shutdown still aborts a concurrent stream after another completes", async () => {
	const runtime = new CodexProviderRuntime();
	const model = getCodexModels()[0];
	if (!model) throw new Error("No registered models");
	const sessionId = "concurrent-stream-shutdown";
	const started = Promise.withResolvers<void>();
	const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
	const options = {
		sessionId,
		apiKey: testApiKey(),
		transport: "sse" as const,
		fetch: Object.assign(
			async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const completion = Promise.withResolvers<Response>();
				const signal = init?.signal;
				if (!signal) throw new Error("Missing request cancellation");
				signal.addEventListener("abort", () => completion.reject(signal.reason), { once: true });
				pending.push(completion);
				if (pending.length === 2) started.resolve();
				return completion.promise;
			},
			{ preconnect() {} },
		),
	};
	const first = runtime.stream(model, { messages: [] }, options).result();
	const second = runtime.stream(model, { messages: [] }, options).result();
	const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
	try {
		await started.promise;
		pending[0]!.resolve(complete());
		expect((await first).stopReason).toBe("stop");
		runtime.shutdownSession({
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => undefined,
			},
		});
		expect((await second).stopReason).toBe("aborted");
	} finally {
		for (const request of pending) request.resolve(complete());
		await Promise.all([first, second]);
		runtime.shutdown();
	}
});
