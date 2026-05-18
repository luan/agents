import { describe, expect, test } from "bun:test";
import { createMosaicV2Tools, DEFAULT_WAIT_AGENT_TIMEOUT_MS, MOSAIC_V2_TOOL_NAMES } from "./v2-tools";

describe("createMosaicV2Tools", () => {
	test("registers compact Codex-shaped tools behind the v2 gate", () => {
		const tools = createMosaicV2Tools(fakeDeps());

		expect(tools.map((tool) => tool.name)).toEqual(MOSAIC_V2_TOOL_NAMES);
		expect(tools.map((tool) => tool.description).join("\n").length).toBeLessThan(700);
	});

	test("send_message and followup_task separate queue-only from trigger-turn delivery", async () => {
		const sent: Array<{ target: string; message: string; triggerTurn: boolean }> = [];
		const tools = createMosaicV2Tools({
			...fakeDeps(),
			sendMessage: async (input) => {
				sent.push(input);
				return { seq: 2 };
			},
		});

		await tools
			.find((tool) => tool.name === "send_message")
			?.execute("1", {
				target: "reviewer",
				message: "remember",
			} as never);
		await tools
			.find((tool) => tool.name === "followup_task")
			?.execute("2", {
				target: "reviewer",
				message: "act now",
			} as never);

		expect(sent).toEqual([
			{ target: "reviewer", message: "remember", triggerTurn: false },
			{ target: "reviewer", message: "act now", triggerTurn: true },
		]);
	});

	test("passes tool context to the HUD hook before executing", async () => {
		const contexts: unknown[] = [];
		const tools = createMosaicV2Tools({ ...fakeDeps(), onToolContext: (ctx) => contexts.push(ctx) });

		await tools
			.find((tool) => tool.name === "list_agents")
			?.execute(
				"1",
				{} as never,
				undefined as never,
				undefined as never,
				{
					ui: "fake-ui",
				} as never,
			);

		expect(contexts).toEqual([{ ui: "fake-ui" }]);
	});

	test("passes spawn cwd through to the mosaic agent launcher", async () => {
		const spawns: unknown[] = [];
		const tools = createMosaicV2Tools({
			...fakeDeps(),
			spawnAgent: async (input) => {
				spawns.push(input);
				return { agentId: "agent-1" };
			},
		});

		await tools
			.find((tool) => tool.name === "spawn_agent")
			?.execute("1", {
				task_name: "nested/task",
				message: "work there",
				model_preset: "fast",
				mode: "in-process",
				run_in_background: false,
				cwd: "packages/app",
			} as never);

		expect(spawns[0]).toMatchObject({
			taskName: "nested/task",
			message: "work there",
			modelPreset: "fast",
			mode: "in-process",
			runInBackground: false,
			cwd: "packages/app",
		});
	});

	test("wait_agent delegates to mailbox sequence waiting", async () => {
		const waited: Array<{ afterSeq?: number; timeoutMs?: number }> = [];
		const tools = createMosaicV2Tools({
			...fakeDeps(),
			waitAgent: async (input) => {
				waited.push(input);
				return { seq: 3, type: "agent_update", agentId: "agent-1", status: "running" };
			},
		});

		const result = await tools
			.find((tool) => tool.name === "wait_agent")
			?.execute("1", {
				after_seq: 2,
				timeout_ms: 10,
			} as never);

		expect(waited).toEqual([{ afterSeq: 2, timeoutMs: 10 }]);
		expect(result?.content[0]?.type === "text" ? result.content[0].text : "").toContain('"seq":3');
	});

	test("wait_agent uses a finite default timeout and serializes empty waits", async () => {
		const waited: Array<{ afterSeq?: number; timeoutMs?: number }> = [];
		const tools = createMosaicV2Tools({
			...fakeDeps(),
			waitAgent: async (input) => {
				waited.push(input);
				return undefined;
			},
		});

		const result = await tools.find((tool) => tool.name === "wait_agent")?.execute("1", {} as never);

		expect(waited).toEqual([{ timeoutMs: DEFAULT_WAIT_AGENT_TIMEOUT_MS }]);
		expect(result?.content[0]?.type === "text" ? result.content[0].text : "").toBe("null");
	});

	test("renders inline spawn calls in the transcript and leaves background calls to the HUD", () => {
		const tools = createMosaicV2Tools(fakeDeps());
		const spawn = tools.find((tool) => tool.name === "spawn_agent");

		expect(spawn?.renderCall?.({ task_name: "mosaic/demo" } as never, theme as never).render(80)[0]).toContain(
			"running inline",
		);
		expect(
			spawn
				?.renderCall?.({ task_name: "mosaic/background", run_in_background: true } as never, theme as never)
				.render(80),
		).toEqual([]);
		expect(spawn?.renderResult?.({ content: [] } as never, {}, theme as never, {}).render(80)).toEqual([]);
	});
});

function fakeDeps() {
	return {
		spawnAgent: async () => ({ agentId: "agent-1", taskName: "reviewer" }),
		sendMessage: async () => ({ seq: 2 }),
		waitAgent: async () => ({ seq: 3 }),
		listAgents: async () => [{ agentId: "agent-1", taskName: "reviewer" }],
		closeAgent: async () => ({ seq: 4 }),
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
