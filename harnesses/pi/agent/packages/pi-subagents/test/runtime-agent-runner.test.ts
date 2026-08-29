import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	findRetryableError,
	prepareAgentRun,
	resolveChildToolNames,
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
		systemPrompt?: string;
		runtime?: object;
	} = {},
) {
	return {
		cwd: options.cwd ?? "/tmp",
		getSystemPrompt: () => options.systemPrompt,
		model: options.parentModel,
		scopedModels: (options.scoped ?? []).map((scopedModel) => ({ model: scopedModel })),
		modelRegistry: {
			getAvailable: () => options.available ?? [],
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
	expect(prepared.systemPrompt).toContain(
		"Spawn another agent only for a concrete, bounded subtask that can run independently alongside useful local work.",
	);
});

test("uses scoped models and reports the effective requested role", async () => {
	const luna = model("gpt-5.6-luna");
	const sol = model("gpt-5.6-sol");
	const resolvedRoles: Array<{ name: string; color: string } | undefined> = [];
	const prepared = await prepareAgentRun(
		context({ available: [sol], scoped: [luna], parentModel: sol }),
		{
			pi: pi(),
			agentConfig: { role: "tiny" },
			onRuntimeResolved: (role) => resolvedRoles.push(role),
		},
		false,
	);

	expect(prepared.model).toBe(luna);
	expect(prepared.thinkingLevel).toBe("low");
	expect(prepared.modelRole).toEqual({ name: "tiny", color: "cyan" });
	expect(resolvedRoles).toEqual([{ name: "tiny", color: "cyan" }]);
});

test("reports the effective default role when the requested role is unavailable", async () => {
	const sol = model("gpt-5.6-sol");
	const prepared = await prepareAgentRun(
		context({ available: [sol] }),
		{ pi: pi(), agentConfig: { role: "tiny" } },
		false,
	);

	expect(prepared.model).toBe(sol);
	expect(prepared.thinkingLevel).toBe("medium");
	expect(prepared.modelRole).toEqual({ name: "balanced", color: "green" });
});

test("falls back to the parent runtime without claiming an unavailable role", async () => {
	const parent = model("parent-model");
	const resolvedRoles: Array<{ name: string; color: string } | undefined> = [];
	const prepared = await prepareAgentRun(
		context({ parentModel: parent }),
		{
			pi: pi(),
			agentConfig: { role: "tiny" },
			onRuntimeResolved: (role) => resolvedRoles.push(role),
		},
		false,
	);

	expect(prepared.model).toBe(parent);
	expect(prepared.thinkingLevel).toBe("max");
	expect(prepared.modelRole).toBeUndefined();
	expect(resolvedRoles).toEqual([undefined]);
});

test("requires Pi 0.84's model runtime compatibility boundary", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-runtime-"));
	try {
		await expect(
			runAgent(context({ cwd }), "delegate", {
				pi: pi(),
				agentConfig: {},
				sessionDir: join(cwd, "sessions"),
			}),
		).rejects.toThrow("Pi model runtime is unavailable to the subagent session");
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
