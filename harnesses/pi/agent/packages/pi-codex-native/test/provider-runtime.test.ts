import { expect, test } from "bun:test";
import { getCodexModels } from "../src/provider/models.ts";
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
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		}),
	).toString("base64url");
	const internal = runtime as unknown as {
		requestAuth: Map<string, { apiKey: string }>;
	};
	internal.requestAuth.set("session-1", { apiKey: `header.${payload}.signature` });
	const model = getCodexModels().find((candidate) => candidate.id === "gpt-5.6-sol");
	expect(model).toBeDefined();
	if (!model) throw new Error("The test model is missing");

	const body: ResponsesBody = {
		...baseBody,
		input: [
			{ role: "user", content: [{ type: "input_text", text: "Retained message" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		],
	};
	await runtime.startCompactionPrewarm({ sessionId: "session-1", model, body });
	await runtime.startCompactionPrewarm({ sessionId: "session-1", model, body });

	expect(bodies).toEqual([body]);
	expect(bodies[0]).toBe(body);
	expect(bodies[0]).not.toHaveProperty("compaction_trigger");

	const changedBody = { ...body, instructions: "A new final Pi system prompt." };
	await runtime.startCompactionPrewarm({ sessionId: "session-1", model, body: changedBody });
	expect(bodies).toEqual([body, changedBody]);
});
