import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/core/types.ts";
import {
	findRetryableError,
	prepareAgentRun,
	resolveChildToolNames,
	resolveModel,
	resumeAgent,
	runAgent,
	sendAgentTask,
} from "../src/runtime/agent-runner.ts";

function model(id: string, reasoning = true): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 32_000,
	};
}

function pi(activeTools: string[] = []) {
	return {
		getActiveTools: () => activeTools,
		getThinkingLevel: () => "max",
	} as never;
}

function context(
	options: {
		cwd?: string;
		parentModel?: Model<Api>;
		available?: Model<Api>[];
		scoped?: Model<Api>[];
		thinkingLevel?: ThinkingLevel;
		systemPrompt?: string;
		runtime?: object;
	} = {},
) {
	return {
		cwd: options.cwd ?? "/tmp",
		getSystemPrompt: () => options.systemPrompt,
		model: options.parentModel,
		thinkingLevel: options.thinkingLevel,
		scopedModels: (options.scoped ?? []).map((scopedModel) => ({ model: scopedModel })),
		modelRegistry: {
			getAvailable: () => options.available ?? [],
			find: (provider: string, id: string) =>
				(options.available ?? []).find((candidate) => candidate.provider === provider && candidate.id === id),
			...(options.runtime ? { runtime: options.runtime } : {}),
		},
	} as never;
}

test("replaces inherited collaboration identity at the runner boundary", async () => {
	const prepared = await prepareAgentRun(
		context({
			systemPrompt:
				"# Parent\n<root_agent_context>root identity</root_agent_context>\n<sub_agent_context>old identity</sub_agent_context>",
		}),
		{
			pi: pi(),
			agentConfig: {},
			collaboration: { agentPath: "/root/review", maxConcurrency: 8, maxDepth: 2 },
		},
		false,
	);

	expect(prepared.systemPrompt).toContain("# Parent");
	expect(prepared.systemPrompt).toContain("You are `/root/review`");
	expect(prepared.systemPrompt.match(/<sub_agent_context>/g)).toHaveLength(1);
	expect(prepared.systemPrompt).not.toContain("root identity");
	expect(prepared.systemPrompt).not.toContain("old identity");
	expect(prepared.systemPrompt).not.toContain("multi-agent delegation");
});

test("inherits the parent model and thinking level", async () => {
	const luna = model("gpt-5.6-luna");
	const sol = model("gpt-5.6-sol");
	const prepared = await prepareAgentRun(
		context({ available: [sol, luna], parentModel: sol, thinkingLevel: "low" }),
		{
			pi: pi(),
			agentConfig: {},
		},
		false,
	);

	expect(prepared.model).toBe(sol);
	expect(prepared.thinkingLevel).toBe("low");
});

test("resolves direct model and thinking-level overrides through Pi APIs", async () => {
	const luna = model("gpt-5.6-luna");
	const sol = model("gpt-5.6-sol");
	const prepared = await prepareAgentRun(
		context({ available: [sol, luna], parentModel: sol, thinkingLevel: "low" }),
		{ pi: pi(), agentConfig: { model: { provider: luna.provider, id: luna.id }, thinkingLevel: "high" } },
		false,
	);

	expect(prepared.model).toBe(luna);
	expect(prepared.thinkingLevel).toBe("high");
});

test("resolves a unique bare model alias inside the active model scope", () => {
	const luna = model("gpt-5.6-luna");
	const sol = model("gpt-5.6-sol");

	expect(resolveModel(context({ available: [sol, luna], scoped: [luna], parentModel: sol }), "luna")).toBe(luna);
});

test("rejects ambiguous bare model aliases", () => {
	const luna = model("gpt-5.6-luna");
	const lunaPreview = model("gpt-5.6-luna-preview");

	expect(() => resolveModel(context({ available: [luna, lunaPreview] }), "luna")).toThrow(
		'Model "luna" is ambiguous; use provider/model-id',
	);
});

test("keeps direct model overrides inside the active model scope", async () => {
	const scoped = model("scoped-model");
	const outside = model("outside-model");
	await expect(
		prepareAgentRun(
			context({ available: [scoped, outside], scoped: [scoped], parentModel: scoped }),
			{ pi: pi(), agentConfig: { model: { provider: outside.provider, id: outside.id } } },
			false,
		),
	).rejects.toThrow("Unknown model: openai-codex/outside-model");
});

test("rejects unknown model overrides", async () => {
	const parent = model("parent-model");
	await expect(
		prepareAgentRun(
			context({ available: [parent], parentModel: parent }),
			{ pi: pi(), agentConfig: { model: { provider: "missing", id: "model" } } },
			false,
		),
	).rejects.toThrow("Unknown model: missing/model");
});

test.each([
	{ reasoning: true, expected: "high" },
	{ reasoning: false, expected: "off" },
] as const)("keeps inherited effort restorable for reasoning=$reasoning", async ({ reasoning, expected }) => {
	const selected = model("selected", reasoning);
	let selection: AgentConfig = {};
	const prepared = await prepareAgentRun(
		context({ available: [selected], thinkingLevel: "max" }),
		{
			pi: pi(),
			agentConfig: { model: { provider: selected.provider, id: selected.id } },
			onRuntimeResolved: (resolved) => {
				selection = resolved;
			},
		},
		false,
	);
	expect(prepared.thinkingLevel).toBe(expected);
	expect(selection).toEqual({ model: { provider: selected.provider, id: selected.id }, thinkingLevel: expected });
	const restored = await prepareAgentRun(
		context({ available: [selected], thinkingLevel: "low" }),
		{ pi: pi(), agentConfig: selection },
		false,
	);
	expect(restored.model).toBe(selected);
	expect(restored.thinkingLevel).toBe(expected);
});

test("rejects thinking levels unsupported by the selected model", async () => {
	const plain = model("plain", false);
	await expect(
		prepareAgentRun(
			context({ available: [plain], parentModel: plain }),
			{ pi: pi(), agentConfig: { thinkingLevel: "high" } },
			false,
		),
	).rejects.toThrow('Thinking level "high" is unavailable');
});

test("rejects an unavailable model runtime before creating session state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-runtime-"));
	try {
		await expect(
			runAgent(context({ cwd }), "delegate", {
				pi: pi(),
				agentConfig: {},
				sessionDir: join(cwd, "sessions"),
			}),
		).rejects.toThrow("Pi model runtime is unavailable to the subagent session");
		expect(await readdir(cwd)).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("findRetryableError describes only the latest assistant outcome", () => {
	const sessions = SessionManager.inMemory();
	sessions.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
	sessions.appendMessage({
		...assistant("error"),
		errorMessage: "provider unavailable",
		timestamp: 2,
	});
	sessions.appendMessage({ role: "user", content: [{ type: "text", text: "retry" }], timestamp: 3 });

	expect(findRetryableError(sessions.getBranch())).toBe("provider unavailable");

	sessions.appendMessage({ ...assistant("stop"), timestamp: 4 });
	expect(findRetryableError(sessions.getBranch())).toBeUndefined();
});

test("findRetryableError supplies a stable fallback for provider errors without a message", () => {
	const sessions = SessionManager.inMemory();
	sessions.appendMessage({ ...assistant("error"), timestamp: 1 });

	expect(findRetryableError(sessions.getBranch())).toBe("Assistant request failed");
});

test("resumeAgent releases subscriptions and abort forwarding when prompting fails", async () => {
	const controller = new AbortController();
	const listeners: Array<(event: never) => void> = [];
	let unsubscribeCount = 0;
	let abortCount = 0;
	const session = {
		messages: [],
		subscribe(listener: (event: never) => void) {
			listeners.push(listener);
			return () => unsubscribeCount++;
		},
		prompt: async () => {
			throw new Error("provider exploded");
		},
		abort: async () => {
			abortCount++;
		},
	} as never;

	await expect(
		resumeAgent(session, "continue", {
			signal: controller.signal,
			onToolActivity: () => {},
		}),
	).rejects.toThrow("provider exploded");
	controller.abort();

	expect(listeners).toHaveLength(2);
	expect(unsubscribeCount).toBe(2);
	expect(abortCount).toBe(0);
});

test.each([false, true])("cancelled follow-up starts no work (collaboration: %s)", async (collaboration) => {
	const calls: string[] = [];
	const session = {
		messages: [],
		sessionManager: SessionManager.inMemory(),
		subscribe: () => {
			calls.push("subscribe");
			return () => calls.push("unsubscribe");
		},
		prompt: async () => {
			calls.push("prompt");
		},
		sendCustomMessage: async () => {
			calls.push("task");
		},
		abort: async () => {
			calls.push("abort");
		},
	} as never;
	const reason = new Error("cancelled before follow-up");
	await expect(
		resumeAgent(session, "continue", {
			signal: AbortSignal.abort(reason),
			...(collaboration ? { collaboration: { agentPath: "/root/review" } } : {}),
		}),
	).rejects.toBe(reason);
	expect(calls).toEqual([]);
});

test("cancelled agent starts no resource or session setup", async () => {
	const reason = new Error("cancelled before startup");
	await expect(
		runAgent(context(), "delegate", {
			pi: pi(),
			agentConfig: {},
			signal: AbortSignal.abort(reason),
		}),
	).rejects.toBe(reason);
});

test("delivers assigned work as a hidden child task", async () => {
	const sent: Array<{ message: object; options: object | undefined }> = [];
	const session = {
		sendCustomMessage: async (message: object, options: object | undefined) => sent.push({ message, options }),
	} as never;

	await sendAgentTask(session, "inspect the shared path", { agentPath: "/root/review" }, { triggerTurn: true });

	expect(sent).toEqual([
		{
			message: {
				customType: "subagent-task",
				content: "Message Type: NEW_TASK\nTask name: /root/review\nSender: /root\nPayload:\ninspect the shared path",
				display: false,
				details: { version: 1, target: "/root/review", sender: "/root" },
			},
			options: { triggerTurn: true },
		},
	]);
});

test("inherits the parent's active tool names and installed project skills", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-runner-"));
	const skillDir = join(cwd, ".pi", "skills", "runner-inherited");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		"---\nname: runner-inherited\ndescription: Proves child resource discovery.\n---\n\n# Runner inherited\n",
	);

	try {
		const prepared = await prepareAgentRun(context({ cwd, systemPrompt: "# Parent identity" }), {
			pi: pi(["read", "spawn_agent"]),
			agentConfig: {},
		});

		expect(prepared.toolNames).toEqual(expect.arrayContaining(["read", "spawn_agent"]));
		expect(prepared.loader.getSkills().skills.map((skill) => skill.name)).toContain("runner-inherited");
		expect(prepared.systemPrompt).toBe("# Parent identity");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("inherits tools lifted behind code mode into child sessions", async () => {
	expect(resolveChildToolNames(["exec", "spawn_agent"], ["exec_command", "write_stdin", "exec"])).toEqual([
		"exec",
		"spawn_agent",
		"exec_command",
		"write_stdin",
	]);
});

function assistant(stopReason: "stop" | "error"): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}
