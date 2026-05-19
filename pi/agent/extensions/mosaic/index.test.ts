import { afterEach, describe, expect, test } from "bun:test";
import registerMosaic, { __getMosaicProcessStateForTest, __resetMosaicProcessStateForTest } from "./index";
import { MOSAIC_TOOL_NAMES } from "./tools";

afterEach(() => {
	delete process.env.MOSAIC_BOOTSTRAP_FILE;
	__resetMosaicProcessStateForTest();
});

describe("mosaic extension registration", () => {
	test("registers compact tool surface by default", () => {
		const tools: Array<{ name: string }> = [];
		registerMosaic(createFakePi({ onTool: (tool) => tools.push(tool) }) as never);

		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...MOSAIC_TOOL_NAMES]));
		expect(tools).toHaveLength(MOSAIC_TOOL_NAMES.length);
	});

	test("registers /mosaic settings and list subcommands instead of /agents", () => {
		const commands = new Map<string, any>();
		registerMosaic(createFakePi({ onCommand: (name, command) => commands.set(name, command) }) as never);

		expect(commands.has("agents")).toBe(false);
		expect(commands.has("mosaic")).toBe(true);
		expect(commands.get("mosaic").getArgumentCompletions("")).toEqual([
			{
				value: "settings",
				label: "settings",
				description: "Configure agents, model defaults, schedules, and mosaic behavior",
			},
			{
				value: "list",
				label: "list",
				description: "List and manage backgrounded mosaic sessions",
			},
		]);
		expect(commands.get("mosaic").getArgumentCompletions("s")).toEqual([
			{
				value: "settings",
				label: "settings",
				description: "Configure agents, model defaults, schedules, and mosaic behavior",
			},
		]);
	});

	test("keeps native message state in a process singleton across hot reloads", () => {
		const first = __getMosaicProcessStateForTest();
		first.messageServer.registerAgent({ agentId: "agent-1", taskName: "reload/probe" });

		const second = __getMosaicProcessStateForTest();

		expect(second.messageServer.listAgents()).toMatchObject([{ agentId: "agent-1", taskName: "reload/probe" }]);
		expect(second.fullSessionAgents).toBe(first.fullSessionAgents);
	});

	test("restarts native message state when a stale singleton has an old protocol version", () => {
		const staleFullSessionAgents = new Map();
		(globalThis as any)[Symbol.for("mosaic:process-state")] = {
			protocolVersion: 2,
			fullSessionAgents: staleFullSessionAgents,
			messageServer: { listAgents: () => [{ agentId: "stale" }] },
		};

		const upgraded = __getMosaicProcessStateForTest();

		expect(upgraded.fullSessionAgents).toBe(staleFullSessionAgents);
		expect(upgraded.messageServer.listAgents()).toEqual([]);
	});

	test("restarts native message state when singleton message server is missing required methods", () => {
		const staleFullSessionAgents = new Map();
		let unsubscribed = false;
		(globalThis as any)[Symbol.for("mosaic:process-state")] = {
			protocolVersion: 4,
			fullSessionAgents: staleFullSessionAgents,
			messageServer: { listAgents: () => [{ agentId: "stale" }] },
			messageUpdateUnsubscribe: () => {
				unsubscribed = true;
			},
		};

		const upgraded = __getMosaicProcessStateForTest();

		expect(upgraded.fullSessionAgents).toBe(staleFullSessionAgents);
		expect(upgraded.messageServer.listAgents()).toEqual([]);
		expect(typeof upgraded.messageServer.onUpdate).toBe("function");
		expect(unsubscribed).toBe(true);
	});

	test("does not register the HUD on session start when a stale running full-session agent has no live heartbeat", async () => {
		const state = __getMosaicProcessStateForTest();
		state.fullSessionAgents.set("agent-1", {
			id: "agent-1",
			laneId: "agent-1",
			type: "general-purpose",
			description: "reload/probe",
			sessionFile: "/tmp/mosaic-session.jsonl",
			paneId: "%1",
			windowId: "@1",
			windowName: "mc: reload/probe",
			startedAt: Date.now() - 1000,
			status: "running",
			mosaicIdentity: { label: "A1", color: "f38ba8" },
		});
		const widgets: unknown[] = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const pi = createFakePi({
			onEvent: (event, handler) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			ui: {
				setWidget: (_name: string, widget: unknown) => widgets.push(widget),
				setStatus() {},
			},
		});

		registerMosaic(pi as never);
		await handlers.session_start?.at(-1)?.(
			{},
			{
				cwd: "/tmp",
				ui: pi.ui,
				sessionManager: { getSessionId: () => undefined },
			},
		);

		expect(widgets).toEqual([]);
	});

	test("does not register the HUD on session start when only completed full-session agents survived reload", async () => {
		const state = __getMosaicProcessStateForTest();
		state.fullSessionAgents.set("agent-1", {
			id: "agent-1",
			laneId: "agent-1",
			type: "general-purpose",
			description: "reload/completed",
			sessionFile: "/tmp/mosaic-session.jsonl",
			paneId: "%1",
			windowId: "@1",
			windowName: "mc: reload/completed",
			startedAt: Date.now() - 1000,
			completedAt: Date.now(),
			status: "completed",
			mosaicIdentity: { label: "A1", color: "f38ba8" },
		});
		const widgets: unknown[] = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const pi = createFakePi({
			onEvent: (event, handler) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			ui: {
				setWidget: (_name: string, widget: unknown) => widgets.push(widget),
				setStatus() {},
			},
		});

		registerMosaic(pi as never);
		await handlers.session_start?.at(-1)?.(
			{},
			{
				cwd: "/tmp",
				ui: pi.ui,
				sessionManager: { getSessionId: () => undefined },
			},
		);

		expect(widgets).toEqual([]);
	});

	test("does not touch widget UI on idle session start", async () => {
		const uiCalls: Array<{ method: string; key: string; value: unknown }> = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const pi = createFakePi({
			onEvent: (event, handler) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			ui: {
				setWidget: (key: string, value: unknown) => uiCalls.push({ method: "setWidget", key, value }),
				setStatus: (key: string, value: unknown) => uiCalls.push({ method: "setStatus", key, value }),
			},
		});

		registerMosaic(pi as never);
		await handlers.session_start?.at(-1)?.(
			{},
			{
				cwd: "/tmp",
				ui: pi.ui,
				sessionManager: { getSessionId: () => undefined },
			},
		);

		expect(uiCalls).toEqual([]);
	});

	test("does not render the agents HUD inside a mosaic child session", async () => {
		process.env.MOSAIC_BOOTSTRAP_FILE = "/tmp/mosaic-child-bootstrap.json";
		const state = __getMosaicProcessStateForTest();
		state.fullSessionAgents.set("agent-1", {
			id: "agent-1",
			laneId: "agent-1",
			type: "general-purpose",
			description: "sibling/probe",
			sessionFile: "/tmp/mosaic-session.jsonl",
			paneId: "%1",
			windowId: "@1",
			windowName: "mc: sibling/probe",
			startedAt: Date.now() - 1000,
			completedAt: Date.now(),
			status: "completed",
			mosaicIdentity: { label: "A1", color: "f38ba8" },
		});
		const widgets: unknown[] = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const pi = createFakePi({
			onEvent: (event, handler) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
			ui: {
				setWidget: (_name: string, widget: unknown) => widgets.push(widget),
				setStatus() {},
			},
		});

		registerMosaic(pi as never);
		await handlers.session_start?.at(-1)?.(
			{},
			{
				cwd: "/tmp",
				ui: pi.ui,
				sessionManager: { getSessionId: () => undefined },
			},
		);

		expect(widgets).toEqual([]);
	});

	test("delivers native full-session completion as a parent follow-up message", () => {
		const sent: Array<{ message: any; options?: unknown }> = [];
		const pi = createFakePi({
			onSendMessage: (message, options) => sent.push({ message, options }),
		});
		registerMosaic(pi as never);
		const state = __getMosaicProcessStateForTest();
		const { token } = state.messageServer.registerAgent({
			agentId: "agent-1",
			taskName: "review/probe",
			type: "general-purpose",
			description: "review/probe",
		});
		state.fullSessionAgents.set("agent-1", {
			id: "agent-1",
			laneId: "agent-1",
			type: "general-purpose",
			description: "review/probe",
			sessionFile: "/tmp/mosaic-session.jsonl",
			paneId: "%1",
			windowId: "@1",
			windowName: "mc: review/probe",
			startedAt: 1000,
			status: "running",
			mosaicIdentity: { label: "A1", color: "f38ba8" },
		});

		state.messageServer.connectAgent("agent-1", token);
		state.messageServer.recordAgentUpdate("agent-1", token, {
			status: "completed",
			result: "FULL_NATIVE_RESULT",
		});
		state.messageServer.recordAgentUpdate("agent-1", token, {
			status: "running",
			activity: "writing",
			result: "STALE",
		});
		state.messageServer.closeAgent("agent-1");

		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(sent[0]?.message).toMatchObject({
			customType: "subagent-notification",
			display: true,
		});
		expect(sent[0]?.message.content).toContain("FULL_NATIVE_RESULT");
	});
});

function createFakePi(
	options: {
		onTool?: (tool: { name: string }) => void;
		onCommand?: (name: string, command: any) => void;
		onEvent?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
		onSendMessage?: (message: unknown, options?: unknown) => void;
		ui?: { setWidget: (name: string, widget: unknown) => void; setStatus: (name: string, status: unknown) => void };
	} = {},
) {
	return {
		ui: options.ui,
		registerTool: (tool: { name: string }) => options.onTool?.(tool),
		registerMessageRenderer() {},
		registerCommand(name: string, command: any) {
			options.onCommand?.(name, command);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			options.onEvent?.(event, handler);
			return () => {};
		},
		getAllTools: () => [],
		setActiveTools() {},
		setSessionName() {},
		sendMessage: (message: unknown, sendOptions?: unknown) => options.onSendMessage?.(message, sendOptions),
		sendUserMessage() {},
		events: {
			on() {
				return () => {};
			},
			emit() {},
		},
	};
}
