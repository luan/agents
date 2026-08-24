import { expect, test } from "bun:test";
import { buildRequestBody } from "../src/provider/request-body.ts";
import { createCodexPrewarmIdentity } from "../src/provider/runtime.ts";
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

test("the provider serializes the final prompt without rebuilding it", () => {
	const finalPrompt = [
		"You are an expert coding agent operating inside Pi.",
		"",
		"## Available tools",
		"",
		"- `web__run`: Search and read web sources.",
		"",
		"Current working directory: /repo",
	].join("\n");
	const body = buildRequestBody(model, {
		systemPrompt: finalPrompt,
		messages: [{ role: "user", content: "Inspect the repository." }],
		tools: [],
	} as never);

	expect(body.instructions).toBe(finalPrompt);
	const identityInput = {
		url: "wss://chatgpt.com/backend-api/codex/responses",
		accountId: "account-1",
		headers: new Headers({ originator: "pi" }),
	};
	expect(createCodexPrewarmIdentity({ ...identityInput, body })).not.toBe(
		createCodexPrewarmIdentity({
			...identityInput,
			body: { ...body, instructions: `${finalPrompt}\nChanged mode guidance.` },
		}),
	);
});

test("web_run keeps its usage guidance in the tool description", () => {
	expect(createWebRunTool().description).toContain(
		"Use this when current web information or direct source attribution is required.",
	);
	expect(createWebRunTool().promptGuidelines).toBeUndefined();
});

test("the provider does not author a fallback prompt", () => {
	const body = buildRequestBody(model, {
		systemPrompt: "",
		messages: [],
		tools: [],
	} as never);
	expect(body.instructions).toBe("");
});
