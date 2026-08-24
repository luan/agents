import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import registerNativeCompaction from "../src/compaction/extension.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";
import { serializeMessagesToResponsesInput } from "../src/compaction/serializer.ts";
import { createNativeCompactionDetails, NATIVE_COMPACTION_SHIM_SUMMARY } from "../src/compaction/types.ts";

// type-boundary: These records model the small subset of the external Pi extension API used by this harness.
type TestRecord = Record<string, unknown>;
type Hook = (event: TestRecord, context: TestRecord) => unknown;
type CompactionStreamContext = TestRecord & { systemPrompt: string };
type CompactionStreamOptions = {
	onPayload: (payload: TestRecord) => Promise<TestRecord | undefined>;
	onOutputItemDone: (item: TestRecord) => void;
};

function failedStream(error: Error): AsyncGenerator<never> {
	return (async function* () {
		yield* [] as never[];
		throw error;
	})();
}

function hooks(options: { activeTools?: string[]; allTools?: unknown[]; fallbackCompaction?: boolean } = {}) {
	const registered = new Map<string, Hook>();
	registerNativeCompaction(
		{
			on(name: string, handler: Hook) {
				registered.set(name, handler);
			},
			getActiveTools: () => options.activeTools ?? [],
			getAllTools: () => options.allTools ?? [],
			getThinkingLevel: () => "medium",
		} as never,
		undefined,
		() => ({
			...DEFAULT_CODEX_NATIVE_SETTINGS,
			fallbackCompaction: options.fallbackCompaction ?? true,
		}),
	);
	return registered;
}

function compactEvent(signal = new AbortController().signal) {
	return {
		signal,
		reason: "manual",
		preparation: {
			tokensBefore: 1_000,
			firstKeptEntryId: "entry-1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
		},
	};
}

test("the compaction hook delegates non-Codex models to Pi", async () => {
	const handler = hooks().get("session_before_compact");
	expect(handler).toBeDefined();
	const result = await handler?.(compactEvent(), {
		model: { provider: "anthropic", api: "anthropic-messages" },
	});
	expect(result).toBeUndefined();
});

test("the compaction hook cancels an aborted Codex request before transport", async () => {
	const controller = new AbortController();
	controller.abort();
	const handler = hooks().get("session_before_compact");
	const result = await handler?.(compactEvent(controller.signal), {
		model: { provider: "openai-codex", api: "openai-codex-responses" },
	});
	expect(result).toEqual({ cancel: true });
});

test("the provider hook leaves sessions without a remote checkpoint unchanged", async () => {
	const handler = hooks().get("before_provider_request");
	expect(handler).toBeDefined();
	const result = await handler?.(
		{ payload: { model: "gpt-5.6-sol", input: [] } },
		{
			model: { provider: "openai-codex", api: "openai-codex-responses" },
			sessionManager: { getBranch: () => [] },
		},
	);
	expect(result).toBeUndefined();
});

test("the provider hook restores the remote replay window after session resume", async () => {
	const handler = hooks().get("before_provider_request");
	const model = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as Model<Api>;
	const kept = {
		type: "message",
		id: "kept",
		timestamp: "2026-08-17T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "old context" }],
			timestamp: 1,
		},
	};
	const compactedWindow = [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "retained request" }],
		},
		{ type: "compaction", encrypted_content: "opaque" },
	];
	const compaction = {
		type: "compaction",
		id: "compact",
		timestamp: "2026-08-17T00:00:01.000Z",
		summary: NATIVE_COMPACTION_SHIM_SUMMARY,
		firstKeptEntryId: kept.id,
		tokensBefore: 1_000,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow,
		}),
	};
	const tail = {
		type: "message",
		id: "tail",
		timestamp: "2026-08-17T00:00:02.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "new request" }],
			timestamp: 2,
		},
	};
	const summaryMessage = {
		role: "compactionSummary",
		summary: compaction.summary,
		tokensBefore: compaction.tokensBefore,
		timestamp: new Date(compaction.timestamp).getTime(),
	};
	const piReplay = serializeMessagesToResponsesInput(model, [summaryMessage, kept.message, tail.message] as never);
	const agentsContext = {
		role: "user",
		content: [
			{
				type: "input_text",
				text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nRules.\n</INSTRUCTIONS>",
			},
		],
	};
	const jwtPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		}),
	).toString("base64url");
	const result = await handler?.(
		{
			payload: {
				model: model.id,
				instructions: "system",
				input: [agentsContext, ...piReplay],
			},
		},
		{
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: `header.${jwtPayload}.signature`,
				}),
			},
			sessionManager: {
				getBranch: () => [kept, compaction, tail],
			},
			hasUI: false,
		},
	);
	const rewritten = result as { input: unknown[] };
	expect(rewritten.input).toEqual([
		agentsContext,
		...compactedWindow,
		...serializeMessagesToResponsesInput(model, [tail.message] as never),
	]);
	expect(JSON.stringify(rewritten.input)).not.toContain("old context");
});

test("the compaction request rebuilds the current instructions, developer guidance, and AGENTS context", async () => {
	const serviceKey = Symbol.for("pi-developer-prompt/envelope-service/v1");
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	const previous = slots[serviceKey];
	let sent: Record<string, unknown> | undefined;
	const model = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as Model<Api>;
	const userEntry = {
		type: "message",
		id: "user-entry",
		timestamp: "2026-08-18T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "actual request" }],
			timestamp: 1,
		},
	};
	const developerAuditEntry = {
		type: "custom_message",
		id: "developer-audit-entry",
		parentId: userEntry.id,
		timestamp: "2026-08-18T00:00:01.000Z",
		customType: "pi-developer-prompt/developer",
		content: "audit-only developer marker",
		display: true,
		details: { role: "developer", id: "skills" },
	};
	const contextAuditEntry = {
		type: "custom_message",
		id: "context-audit-entry",
		parentId: developerAuditEntry.id,
		timestamp: "2026-08-18T00:00:02.000Z",
		customType: "pi-developer-prompt/context-user",
		content: "audit-only user marker",
		display: true,
		details: { role: "user", id: "agents-md" },
	};
	const branch = [userEntry, developerAuditEntry, contextAuditEntry];
	const jwtPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		}),
	).toString("base64url");
	let currentEnvelope: Record<string, unknown> | undefined;
	slots[serviceKey] = {
		current: () => currentEnvelope,
	};
	try {
		const registered = hooks({
			activeTools: ["skill"],
			allTools: [{ name: "skill" }],
		});
		const streamSimple = async function* (
			_model: Model<Api>,
			context: CompactionStreamContext,
			options: CompactionStreamOptions,
		) {
			sent = await options.onPayload({
				model: model.id,
				store: false,
				stream: true,
				instructions: context.systemPrompt,
				input: [],
				text: { verbosity: "low" },
				include: ["reasoning.encrypted_content"],
				tool_choice: "auto",
				parallel_tool_calls: true,
			});
			options.onOutputItemDone({
				type: "compaction",
				encrypted_content: "opaque",
			});
			yield {
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
					responseId: "resp_compact",
				},
			};
		};
		const context = {
			model,
			cwd: "/repo",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: `header.${jwtPayload}.signature`,
				}),
				getRegisteredNativeProvider: () => ({ streamSimple }),
			},
			sessionManager: {
				getSessionId: () => "fresh-envelope",
				getBranch: () => branch,
				getEntries: () => branch,
				getLeafId: () => contextAuditEntry.id,
			},
			getSystemPrompt: () => "Pi base",
			hasUI: false,
		};
		const withoutCapture = await registered.get("session_before_compact")?.(compactEvent(), context);
		expect(withoutCapture).toBeUndefined();
		expect(sent).toBeUndefined();
		currentEnvelope = {
			systemPrompt: "owned:after reload",
			developerMessages: [{ id: "skills", content: "tools:skill" }],
			contextualUserMessages: [
				{
					id: "agents-md",
					content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>Current rules.</INSTRUCTIONS>",
				},
			],
		};
		const result = await registered.get("session_before_compact")?.(compactEvent(), context);
		expect(result).toHaveProperty("compaction");
		expect(sent?.instructions).toBe("owned:after reload");
		const input = JSON.stringify(sent?.input);
		expect(input).toContain("tools:skill");
		expect(input).toContain("Current rules.");
		expect(input).toContain("actual request");
		expect(input).not.toContain("Pi base");
		expect(input).not.toContain("audit-only developer marker");
		expect(input).not.toContain("audit-only user marker");
	} finally {
		if (previous === undefined) delete slots[serviceKey];
		else slots[serviceKey] = previous;
	}
});

async function expectPiFallback(
	streamSimple: () => AsyncGenerator<unknown>,
	captureAvailable = true,
	abortBeforeFallbackRequest = false,
	fallbackCompaction = true,
): Promise<void> {
	const serviceKey = Symbol.for("pi-developer-prompt/envelope-service/v1");
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	const previousService = slots[serviceKey];
	slots[serviceKey] = {
		current: () =>
			captureAvailable
				? {
						systemPrompt: "system",
						developerMessages: [],
						contextualUserMessages: [],
					}
				: undefined,
	};
	const registered = hooks({ fallbackCompaction });
	const compact = registered.get("session_before_compact");
	const beforeRequest = registered.get("before_provider_request");
	const model = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as Model<Api>;
	const kept = {
		type: "message",
		id: "kept-fallback",
		timestamp: "2026-08-17T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: 1,
		},
	};
	const compactedWindow = [{ type: "compaction", encrypted_content: "prior-opaque" }];
	const checkpoint = {
		type: "compaction",
		id: "compact-fallback",
		timestamp: "2026-08-17T00:00:01.000Z",
		summary: NATIVE_COMPACTION_SHIM_SUMMARY,
		firstKeptEntryId: kept.id,
		tokensBefore: 1_000,
		details: createNativeCompactionDetails({
			provider: model.provider,
			api: model.api,
			model: model.id,
			baseUrl: model.baseUrl,
			compactedWindow,
		}),
	};
	const tail = {
		type: "message",
		id: "tail-fallback",
		timestamp: "2026-08-17T00:00:02.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "new" }],
			timestamp: 2,
		},
	};
	const branch = [kept, checkpoint, tail];
	const jwtPayload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		}),
	).toString("base64url");
	const sessionManager = {
		getBranch: () => branch,
		getSessionId: () => "session-fallback",
	};
	const notifications: string[] = [];
	const context = {
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: `header.${jwtPayload}.signature`,
			}),
			getRegisteredNativeProvider: () => ({ streamSimple }),
		},
		sessionManager,
		getSystemPrompt: () => "system",
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const controller = new AbortController();
	const compactResult = await compact?.(compactEvent(controller.signal), context);
	if (!fallbackCompaction) {
		expect(compactResult).toEqual({ cancel: true });
		expect(notifications.at(-1)).toContain("Pi fallback compaction is disabled");
		branch.splice(0, branch.length, tail);
		const fallback = await beforeRequest?.(
			{
				payload: {
					model: model.id,
					instructions: "You are a context summarization assistant. Produce only the checkpoint.",
					input: [{ role: "developer", content: "compaction instructions" }],
				},
			},
			context,
		);
		expect(fallback).toBeUndefined();
		if (previousService === undefined) delete slots[serviceKey];
		else slots[serviceKey] = previousService;
		return;
	}
	expect(compactResult).toBeUndefined();
	if (abortBeforeFallbackRequest) {
		controller.abort();
		branch.splice(0, branch.length, tail);
	}

	const fallback = (await beforeRequest?.(
		{
			payload: {
				model: model.id,
				instructions: "You are a context summarization assistant. Produce only the checkpoint.",
				input: [{ role: "developer", content: "compaction instructions" }],
			},
		},
		context,
	)) as { input: unknown[] } | undefined;
	if (abortBeforeFallbackRequest) {
		expect(fallback).toBeUndefined();
		if (previousService === undefined) delete slots[serviceKey];
		else slots[serviceKey] = previousService;
		return;
	}
	if (!fallback) throw new Error("Pi fallback checkpoint was not injected");
	expect(fallback.input).toEqual([{ role: "developer", content: "compaction instructions" }, ...compactedWindow]);
	if (previousService === undefined) delete slots[serviceKey];
	else slots[serviceKey] = previousService;
}

test("an emitted remote error gives Pi fallback the prior encrypted checkpoint", async () => {
	await expectPiFallback(async function* () {
		yield {
			type: "error",
			error: { errorMessage: "transport failed" },
		};
	});
});

test("a thrown remote error gives Pi fallback the prior encrypted checkpoint", async () => {
	await expectPiFallback(() => failedStream(new Error("transport threw")));
});

test("disabled fallback cancels Codex compaction after a remote error", async () => {
	await expectPiFallback(
		async function* () {
			yield {
				type: "error",
				error: { errorMessage: "transport failed" },
			};
		},
		true,
		false,
		false,
	);
});

test("missing prompt capture gives Pi fallback the prior encrypted checkpoint", async () => {
	await expectPiFallback(() => failedStream(new Error("remote transport must not run")), false);
});

test("aborting Pi fallback clears the pending remote checkpoint", async () => {
	await expectPiFallback(() => failedStream(new Error("remote transport must not run")), false, true);
});
