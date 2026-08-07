import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types";
import { AgentHarness, openAgentBrowser } from "./agent-browser";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

initTheme("dark", false);

function record(status: AgentRecord["status"] = "running"): AgentRecord {
	return {
		id: "worker",
		type: "task",
		description: "Review implementation",
		status,
		rootSessionId: "root",
		parentSessionId: "root",
		assignment: "Check **all** paths.",
		cwd: "/tmp",
		events: [{ type: "tool-start", at: 1, toolName: "read" }],
		toolUses: 1,
		startedAt: Date.now(),
		result: "# Result\n- Found issue",
		lifetimeUsage: { input: 10, output: 5, cacheWrite: 0, cost: 0 },
		compactionCount: 0,
	};
}

test("renders a bordered, colored, interactive subagent harness", async () => {
	const steers: Array<{ id: string; message: string }> = [];
	let renders = 0;
	const harness = new AgentHarness(
		[record()],
		{
			steer: async (id, message) => {
				steers.push({ id, message });
				return true;
			},
			stop: () => true,
			followUp: async () => true,
		},
		{ terminal: { rows: 40 }, requestRender: () => renders++ } as never,
		theme,
		() => {},
	);

	const rendered = harness.render(100).join("\n");
	expect(harness.render(100)).toHaveLength(38);
	expect(rendered).toContain("Review implementation");
	expect(rendered).toContain("[ output ]");
	expect(rendered).toContain("<borderAccent>╭");
	expect(rendered).toContain("<mdHeading># Result</mdHeading>");
	expect(rendered).not.toContain("<border>│");

	harness.handleInput("s");
	for (const character of "change direction") harness.handleInput(character);
	harness.handleInput("\r");
	await Bun.sleep(0);

	expect(steers).toEqual([{ id: "worker", message: "change direction" }]);
	expect(renders).toBeGreaterThan(0);
	harness.dispose();
});

test("fits the native overlay height on short terminals", () => {
	const rows = 10;
	const harness = new AgentHarness(
		[record()],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows }, requestRender() {} } as never,
		theme,
		() => {},
	);

	expect(harness.render(80).length).toBeLessThanOrEqual(Math.floor(rows * 0.95));
	harness.dispose();
});

test("opens the browser in Pi's native fullscreen-compatible overlay", async () => {
	let customOptions: unknown = "not called";
	await openAgentBrowser(
		{
			hasUI: true,
			ui: {
				custom: async (_factory: unknown, options: unknown) => {
					customOptions = options;
				},
			},
		} as never,
		[record("completed")],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
	);
	expect(customOptions).toEqual({
		overlay: true,
		overlayOptions: { anchor: "center", width: "95%", maxHeight: "95%" },
	});
});

test("renders the live child session transcript and coalesces session updates", async () => {
	const live = record();
	live.result = "stale completion summary";
	let sessionListener: (() => void) | undefined;
	let renders = 0;
	live.session = {
		subscribe(listener: () => void) {
			sessionListener = listener;
			return () => {
				sessionListener = undefined;
			};
		},
		agent: {
			state: {
				messages: [
					{ role: "user", content: [{ type: "text", text: "Do live work" }] },
					{
						role: "assistant",
						content: [{ type: "text", text: "Live assistant response" }],
						stopReason: "stop",
						timestamp: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				],
			},
		},
	} as never;
	const harness = new AgentHarness(
		[live],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows: 40 }, requestRender: () => renders++ } as never,
		theme,
		() => {},
	);

	const rendered = harness.render(100).join("\n");
	expect(rendered).toContain("Live assistant response");
	expect(rendered).not.toContain("stale completion summary");
	for (let update = 0; update < 100; update++) sessionListener?.();
	expect(renders).toBe(0);
	await Bun.sleep(120);
	expect(renders).toBe(1);
	harness.dispose();
});

test("supports vim scrolling and tail following for a single agent", () => {
	const long = record("completed");
	long.result = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
	const harness = new AgentHarness(
		[long],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows: 40 }, requestRender: () => {} } as never,
		theme,
		() => {},
	);

	let rendered = harness.render(100).join("\n");
	expect(rendered).toContain("line 59");
	expect(rendered).toContain("following");
	harness.handleInput("g");
	harness.handleInput("g");
	const top = harness.render(100).join("\n");
	expect(top).toContain("line 0");
	expect(top).not.toContain("line 59");
	expect(top).toContain("paused");
	harness.handleInput("G");
	expect(harness.render(100).join("\n")).toContain("line 59");
	harness.handleInput("\x1b[<64;10;10M");
	expect(harness.render(100).join("\n")).not.toContain("line 59");
	rendered = harness.render(50).join("\n");
	expect(rendered).not.toContain("new");
	long.result += "\nnew one\nnew two";
	rendered = harness.render(100).join("\n");
	expect(rendered).toContain("2 new");
	harness.handleInput("a");
	rendered = harness.render(100).join("\n");
	expect(rendered).toContain("line 59");
	expect(rendered).not.toContain("2 new");
});

test("refreshes queued agents through their final status", async () => {
	const queued = record("queued");
	let renders = 0;
	const harness = new AgentHarness(
		[queued],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows: 40 }, requestRender: () => renders++ } as never,
		theme,
		() => {},
	);
	await Bun.sleep(300);
	expect(renders).toBeGreaterThan(0);
	queued.status = "completed";
	const beforeFinal = renders;
	await Bun.sleep(300);
	expect(renders).toBeGreaterThan(beforeFinal);
	const afterFinal = renders;
	await Bun.sleep(300);
	expect(renders).toBe(afterFinal);
	harness.dispose();
});

test("shows session and terminal errors in the output tab", () => {
	const failed = record("error");
	failed.error = "manager failure";
	failed.session = {
		subscribe: () => () => {},
		agent: {
			state: {
				messages: [
					{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "provider failure",
						timestamp: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				],
			},
		},
	} as never;
	const harness = new AgentHarness(
		[failed],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows: 40 }, requestRender: () => {} } as never,
		theme,
		() => {},
	);

	const rendered = harness.render(100).join("\n");
	expect(rendered).toContain("provider failure");
	expect(rendered).toContain("manager failure");
});

test("renders file tools as compact summaries", () => {
	const live = record("completed");
	live.session = {
		subscribe: () => () => {},
		agent: {
			state: {
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "read-1",
								name: "read",
								arguments: { path: "src/app.ts", offset: 10, limit: 20 },
							},
						],
						stopReason: "toolUse",
						timestamp: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
					{
						role: "toolResult",
						toolCallId: "read-1",
						toolName: "read",
						content: [{ type: "text", text: "one\ntwo\nthree" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
		},
	} as never;
	const harness = new AgentHarness(
		[live],
		{ steer: async () => true, stop: () => true, followUp: async () => true },
		{ terminal: { rows: 40 }, requestRender: () => {} } as never,
		theme,
		() => {},
	);

	const rendered = harness.render(100).join("\n");
	expect(rendered).toContain("read src/app.ts:10+20");
	expect(rendered).toContain("3 lines");
	expect(rendered).not.toContain('"offset": 10');
	expect(rendered).not.toContain("╭─ read");
});
