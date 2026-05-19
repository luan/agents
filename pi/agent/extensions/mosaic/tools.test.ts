import { describe, expect, test } from "bun:test";
import { createMosaicTools, DEFAULT_WAIT_AGENT_TIMEOUT_MS, MOSAIC_TOOL_NAMES } from "./tools";

describe("createMosaicTools", () => {
	test("registers compact Codex-shaped tools", () => {
		const tools = createMosaicTools(fakeDeps());

		expect(tools.map((tool) => tool.name)).toEqual(MOSAIC_TOOL_NAMES);
		expect(tools.map((tool) => tool.description).join("\n").length).toBeLessThan(700);
	});

	test("send_message and followup_task separate queue-only from trigger-turn delivery", async () => {
		const sent: Array<{ target: string; message: string; triggerTurn: boolean }> = [];
		const tools = createMosaicTools({
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
		const tools = createMosaicTools({ ...fakeDeps(), onToolContext: (ctx) => contexts.push(ctx) });

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
		const tools = createMosaicTools({
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
		const tools = createMosaicTools({
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
		const tools = createMosaicTools({
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

	test("renders foreground spawn calls in the transcript and leaves background calls to the HUD", () => {
		const tools = createMosaicTools(fakeDeps());
		const spawn = tools.find((tool) => tool.name === "spawn_agent");

		expect(
			spawn
				?.renderCall?.(
					{ task_name: "mosaic/demo" } as never,
					theme as never,
					{ state: {}, isPartial: true } as never,
				)
				.render(80)[0],
		).toContain("running inline");
		expect(
			spawn
				?.renderCall?.(
					{ task_name: "mosaic/background", run_in_background: true } as never,
					theme as never,
					{ state: {}, isPartial: true } as never,
				)
				.render(80),
		).toEqual([]);
		expect(
			spawn
				?.renderResult?.(
					{
						content: [],
						details: {
							agentId: "agent-1",
							taskName: "mosaic/background",
							runtime: "in-process",
							background: true,
							status: "running",
						},
					} as never,
					{ expanded: false, isPartial: false },
					theme as never,
					{ state: {} } as never,
				)
				.render(80),
		).toEqual([]);
		expect(spawn?.renderResult?.({ content: [] } as never, {}, theme as never, {}).render(80)).toEqual([]);
	});

	test("renders completed inline spawn calls without time-varying output", () => {
		const originalNow = Date.now;
		const tools = createMosaicTools(fakeDeps());
		const spawn = tools.find((tool) => tool.name === "spawn_agent");
		const context = { state: {}, isPartial: false } as never;
		try {
			Date.now = () => 1_000;
			const component = spawn?.renderCall?.({ task_name: "mosaic/demo" } as never, theme as never, context);
			const first = component?.render(80);
			Date.now = () => 10_000;
			const second = component?.render(80);

			expect(first).toEqual(second);
			expect(first?.[0]).toContain("completed inline");
		} finally {
			Date.now = originalNow;
		}
	});

	test("streams foreground agent output into a five-line box", async () => {
		const updates: unknown[] = [];
		const tools = createMosaicTools({
			...fakeDeps(),
			spawnAgent: async (input) => {
				input.onTextDelta?.("one\ntwo\nthree\nfour");
				return {
					agentId: "agent-1",
					taskName: input.taskName,
					runtime: "in-process",
					background: false,
					status: "completed",
					result: "final\nline",
				};
			},
		});
		const spawn = tools.find((tool) => tool.name === "spawn_agent");

		const result = await spawn?.execute(
			"1",
			{ task_name: "mosaic/demo", message: "go", run_in_background: false } as never,
			undefined as never,
			(update) => updates.push(update),
			{} as never,
		);
		const streamed = spawn
			?.renderResult?.(
				updates[0] as never,
				{ expanded: false, isPartial: true },
				theme as never,
				{ state: {} } as never,
			)
			.render(40);
		const final = spawn
			?.renderResult?.(
				result as never,
				{ expanded: false, isPartial: false },
				theme as never,
				{ state: {} } as never,
			)
			.render(40);

		expect(streamed).toHaveLength(5);
		expect(streamed?.join("\n")).toContain("two");
		expect(streamed?.join("\n")).toContain("four");
		expect(final).toHaveLength(5);
		expect(final?.join("\n")).toContain("final");
		expect(final?.join("\n")).toContain("line");
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
