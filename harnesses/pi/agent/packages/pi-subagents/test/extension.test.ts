import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureXSettingsRegistry } from "pi-xsettings";
import { DEFAULT_SUBAGENT_SETTINGS, registerSubagentSettings } from "../src/config/settings.ts";
import subagentsExtension from "../src/extension.ts";
import { createRootCoordinator, getCoordinatorForSession, removeRootCoordinator } from "../src/runtime/coordinator.ts";

type TestHandler = (event: object, context: ExtensionContext) => object | undefined | Promise<object | undefined>;

test("registers the Agent Widget indicator override in the Agents animation section", () => {
	const unregister = registerSubagentSettings();
	try {
		const definition = ensureXSettingsRegistry().registrations["pi-subagents"]?.definitions.find(
			(candidate) => candidate.key === "agentWidgetIndicator",
		);
		expect(DEFAULT_SUBAGENT_SETTINGS.agentWidgetIndicator).toBe("inherit");
		expect(definition).toMatchObject({
			category: "appearance",
			page: "animations",
			section: "Agents",
			preview: "activity-marker",
			type: "enum",
			default: "inherit",
		});
		if (definition?.type !== "enum" || !Array.isArray(definition.options))
			throw new Error("Agent Widget indicator must be an enum");
		expect(definition.options.map((option) => option.value)).toEqual(
			expect.arrayContaining(["inherit", "off", "spinner", "nerd-pi-orbit"]),
		);
	} finally {
		unregister();
	}
});

test("reconciles an idle coordinator after session-tree navigation", async () => {
	const handlers = new Map<string, TestHandler[]>();
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		on(event: string, handler: TestHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		appendEntry() {},
		sendMessage() {},
	} as never;
	const context = {
		cwd: "/tmp/work",
		hasUI: false,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => "extension-tree-root",
			getSessionDir: () => "/tmp/extension-tree-root",
			getBranch: () => [],
		},
	} as never as ExtensionContext;

	subagentsExtension(pi);
	await emit(handlers, "session_start", {}, context);
	const before = getCoordinatorForSession("extension-tree-root");
	expect(before).toBeDefined();
	expect(tools).toEqual([
		"spawn_agent",
		"followup_task",
		"send_message",
		"interrupt_agent",
		"list_agents",
		"wait_agent",
	]);
	expect(commands).toEqual(["subagents", "retry"]);

	await emit(handlers, "session_tree", {}, context);
	const after = getCoordinatorForSession("extension-tree-root");
	expect(after).toBeDefined();
	expect(after).not.toBe(before);

	await emit(handlers, "session_shutdown", { reason: "quit" }, context);
	expect(getCoordinatorForSession("extension-tree-root")).toBeUndefined();
});

async function emit(
	handlers: ReadonlyMap<string, readonly TestHandler[]>,
	event: string,
	payload: object,
	context: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, context);
}

test("delivers mailbox messages as steering only while the parent is active", async () => {
	const handlers = new Map<string, TestHandler[]>();
	const sent: Array<{ content: string; options: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const pi = {
		on(event: string, handler: TestHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		sendMessage(message: { content: string }, options: { deliverAs?: string; triggerTurn?: boolean }) {
			sent.push({ content: message.content, options });
		},
	} as never;
	const context = extensionContext("mailbox-delivery-root");
	subagentsExtension(pi);
	await emit(handlers, "session_start", {}, context);
	const coordinator = getCoordinatorForSession("mailbox-delivery-root")!;
	await coordinator.sendMessage("/root/worker", "/root", "idle update");
	expect(sent.at(-1)).toMatchObject({ options: { deliverAs: "nextTurn", triggerTurn: false } });
	expect(sent.at(-1)?.content).toContain("Message Type: MESSAGE\nTask name: /root\nSender: /root/worker");

	await emit(handlers, "agent_start", {}, context);
	await coordinator.sendMessage("/root/worker", "/root", "active update");
	expect(sent.at(-1)).toMatchObject({ options: { deliverAs: "steer", triggerTurn: false } });
	await emit(handlers, "session_shutdown", { reason: "quit" }, context);
});

test("retains completion across a reload attachment gap and delivers it exactly once", async () => {
	let resolveRun!: (value: object) => void;
	const runPromise = new Promise<object>((resolve) => {
		resolveRun = resolve;
	});
	const session = {
		state: { messages: [] },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "reload-child-session",
			getBranch: () => [],
		},
		subscribe: () => () => {},
		getSessionStats: () => ({ tokens: { total: 0 }, contextUsage: undefined }),
		getToolDefinition: () => undefined,
		extensionRunner: { getMessageRenderer: () => undefined },
	} as never;
	const runtime = { session, dispose: async () => {} } as never;
	const rootId = "reload-mailbox-root";
	const coordinator = createRootCoordinator(rootId, {
		run: ((_ctx: object, _message: string, options: object) => {
			const callbacks = options as {
				onRuntimeCreated(runtime: never): void;
				onSessionCreated(session: never): void;
			};
			callbacks.onRuntimeCreated(runtime);
			callbacks.onSessionCreated(session);
			return runPromise;
		}) as never,
	});
	const context = extensionContext(rootId);
	const first = extensionHarness();
	subagentsExtension(first.pi);
	await emit(first.handlers, "session_start", {}, context);
	coordinator.spawn(undefined, {
		taskName: "worker",
		message: "finish",
		pi: first.pi,
		ctx: context,
		agentConfig: {},
	});
	await emit(first.handlers, "session_shutdown", { reason: "reload" }, context);
	resolveRun({ responseText: "completed during reload", session, runtime });
	await Promise.resolve();
	await Promise.resolve();
	expect(first.sent).toEqual([]);

	const second = extensionHarness();
	subagentsExtension(second.pi);
	await emit(second.handlers, "session_start", {}, context);
	expect(second.sent).toHaveLength(1);
	expect(second.sent[0]?.content).toContain(
		"Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\ncompleted during reload",
	);
	await emit(second.handlers, "session_shutdown", { reason: "reload" }, context);

	const third = extensionHarness();
	subagentsExtension(third.pi);
	await emit(third.handlers, "session_start", {}, context);
	expect(third.sent).toEqual([]);
	await emit(third.handlers, "session_shutdown", { reason: "quit" }, context);
	removeRootCoordinator(rootId);
});

function extensionContext(sessionId: string): ExtensionContext {
	return {
		cwd: "/tmp/work",
		hasUI: false,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionDir: () => `/tmp/${sessionId}`,
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => undefined,
		},
	} as never;
}

function extensionHarness() {
	const handlers = new Map<string, TestHandler[]>();
	const sent: Array<{ content: string; options: object }> = [];
	const pi = {
		on(event: string, handler: TestHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		sendMessage(message: { content: string }, options: object) {
			sent.push({ content: message.content, options });
		},
	} as never;
	return { handlers, pi, sent };
}
