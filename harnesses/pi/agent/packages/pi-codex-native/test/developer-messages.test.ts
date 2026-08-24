import { afterEach, beforeEach, expect, test } from "bun:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { registerDeveloperPromptExtension } from "../../pi-developer-prompt/src/extension.ts";
import { registerSkillsPromptContribution } from "../../pi-skills/src/prompt.ts";
import { registerCodexPromptPayloadAdapter } from "../src/prompt-payload-adapter.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";

const CONTRIBUTIONS_KEY = Symbol.for("pi-developer-prompt/developer-messages/v1");
const PAYLOAD_ADAPTERS_KEY = Symbol.for("pi-developer-prompt/provider-payload-adapters/v1");
const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
let previousRegistry: unknown;
let previousPayloadAdapters: unknown;

// type-boundary: These records model the small subset of the external Pi extension API used by this harness.
type TestRecord = Record<string, unknown>;
type Handler = (event: TestRecord, context: TestRecord) => TestRecord | undefined;

beforeEach(() => {
	previousRegistry = slots[CONTRIBUTIONS_KEY];
	previousPayloadAdapters = slots[PAYLOAD_ADAPTERS_KEY];
	slots[CONTRIBUTIONS_KEY] = new Map();
	slots[PAYLOAD_ADAPTERS_KEY] = new Map();
});

afterEach(() => {
	slots[CONTRIBUTIONS_KEY] = previousRegistry;
	slots[PAYLOAD_ADAPTERS_KEY] = previousPayloadAdapters;
});

test("Codex keeps the base prompt, skill catalogue, AGENTS.md, and user request in their owned roles", () => {
	const handlers = new Map<string, Handler>();
	registerSkillsPromptContribution();
	registerCodexPromptPayloadAdapter();
	registerDeveloperPromptExtension({
		appendEntry() {},
		getActiveTools: () => ["skill"],
		registerEntryRenderer() {},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	} as never);
	const context = {
		cwd: "/repo",
		model: { provider: "openai-codex" },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
		ui: { notify() {} },
	};
	const startResult = handlers.get("before_agent_start")?.(
		{
			systemPrompt: "Pi base prompt.",
			systemPromptOptions: {
				cwd: "/repo",
				customPrompt: "Owned base prompt.",
				promptGuidelines: ["Use the active tool."],
				contextFiles: [{ path: "/repo/AGENTS.md", content: "Repository rules." }],
				skills: [
					{
						name: "writing-for-agents",
						description: "Write agent instructions.",
						filePath: "/skills/writing-for-agents/SKILL.md",
						disableModelInvocation: false,
					},
				],
			},
		},
		context,
	);
	const contextualResult = handlers.get("context")?.(
		{
			messages: [{ role: "user", content: "Do the work.", timestamp: 1 }],
		},
		context,
	);
	if (!startResult || typeof startResult.systemPrompt !== "string")
		throw new Error("The start hook did not return a prompt");
	if (!contextualResult || !Array.isArray(contextualResult.messages))
		throw new Error("The context hook did not return messages");
	const start = startResult as TestRecord & { systemPrompt: string };
	const contextual = contextualResult as TestRecord & { messages: never };
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
	const payload = buildRequestBody(model, {
		systemPrompt: start.systemPrompt,
		messages: convertToLlm(contextual.messages),
		tools: [],
	} as never);
	const requestResult = handlers.get("before_provider_request")?.({ payload }, context);
	if (!requestResult || !Array.isArray(requestResult.input)) throw new Error("The request hook did not return input");
	const request = requestResult as TestRecord & {
		input: Array<{ role?: string; content?: unknown }>;
		instructions?: string;
	};
	const input = request.input;
	const developer = input.filter((item) => item.role === "developer");
	const users = input.filter((item) => item.role === "user");

	expect(request.instructions).toBe("Owned base prompt.");
	expect(request.instructions).not.toContain("Repository rules.");
	expect(request.instructions).not.toContain("writing-for-agents");
	expect(developer).toHaveLength(2);
	expect(JSON.stringify(developer)).not.toContain("Use the active tool.");
	expect(JSON.stringify(developer[0])).toContain("writing-for-agents");
	expect(JSON.stringify(developer[1])).toContain("environment_context");
	expect(JSON.stringify(developer)).not.toContain("Repository rules.");
	expect(users).toHaveLength(2);
	expect(JSON.stringify(users[0])).toContain("Repository rules.");
	expect(JSON.stringify(users[1])).toContain("Do the work.");
});

test("the Codex adapter replaces its tagged messages and preserves equal provider-owned content", () => {
	registerCodexPromptPayloadAdapter();
	const registry = slots[PAYLOAD_ADAPTERS_KEY] as Map<
		string,
		{
			replaceDeveloperMessages(payload: unknown, messages: readonly { id: string; content: string }[]): unknown;
		}
	>;
	const adapter = registry.get("openai-codex");
	if (!adapter) throw new Error("The Codex prompt payload adapter was not registered");
	const payload = {
		model: "gpt-5.6-sol",
		instructions: "Owned prompt.",
		input: [
			{
				role: "developer",
				content: '<pi_system_prompt_developer_message id="skills">\nOld skills.\n</pi_system_prompt_developer_message>',
			},
			{ role: "developer", content: '<pi_developer_message id="foreign">\nForeign.\n</pi_developer_message>' },
			{ role: "developer", content: "New skills." },
			{ role: "developer", content: "Provider-owned context." },
			{ role: "user", content: "Continue." },
		],
		parallel_tool_calls: true,
	};

	expect(adapter.replaceDeveloperMessages(payload, [{ id: "skills", content: "New skills." }])).toEqual({
		...payload,
		input: [
			{
				role: "developer",
				content: '<pi_developer_prompt_message id="skills">\nNew skills.\n</pi_developer_prompt_message>',
			},
			{ role: "developer", content: '<pi_developer_message id="foreign">\nForeign.\n</pi_developer_message>' },
			{ role: "developer", content: "New skills." },
			{ role: "developer", content: "Provider-owned context." },
			{ role: "user", content: "Continue." },
		],
	});
});

test("disposing the Codex payload adapter removes payload handling", () => {
	const unregisterAdapter = registerCodexPromptPayloadAdapter();
	unregisterAdapter();

	const handlers = new Map<string, Handler>();
	registerDeveloperPromptExtension({
		appendEntry() {},
		getActiveTools: () => ["exec_command"],
		registerEntryRenderer() {},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	} as never);
	const context = {
		cwd: "/repo",
		model: { provider: "openai-codex" },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
		ui: { notify() {} },
	};
	handlers.get("before_agent_start")?.(
		{
			systemPrompt: "Pi base prompt.",
			systemPromptOptions: { cwd: "/repo", customPrompt: "Owned prompt." },
		},
		context,
	);

	expect(
		handlers.get("before_provider_request")?.(
			{
				payload: { instructions: "Pi base prompt.", input: [] },
			},
			context,
		),
	).toBeUndefined();
});
