import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetMosaicBootstrapForTest,
	drainMosaicBootstrapMessages,
	MOSAIC_LEADER_MESSAGE_TOOL_NAME,
	registerMosaicBootstrap,
} from "./bootstrap";
import { MosaicMessageServer, startMosaicMessageTransport } from "./message-server";

afterEach(() => {
	delete process.env.MOSAIC_BOOTSTRAP_FILE;
	__resetMosaicBootstrapForTest();
});

describe("registerMosaicBootstrap native messaging", () => {
	test("connects to the leader transport and drains mailbox messages through Pi APIs", async () => {
		const server = new MosaicMessageServer({ now: () => 1000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		const transport = await startMosaicMessageTransport(server, { host: "127.0.0.1", port: 0 });
		try {
			process.env.MOSAIC_BOOTSTRAP_FILE = writeBootstrap({
				agentId: "agent-1",
				agentType: "Explore",
				description: "Review code",
				prompt: "Initial prompt",
				systemPrompt: "System prompt",
				builtinToolNames: ["read"],
				extensions: false,
				messageEndpoint: transport.endpoint,
				messageToken: token,
			});
			const pi = createFakePi();
			registerMosaicBootstrap(pi as never);

			await pi.handlers.session_start[0]({}, {});

			expect(server.listAgents()[0]).toMatchObject({ agentId: "agent-1", connected: true });

			server.enqueueMessage("reviewer", { body: "Native followup", triggerTurn: true });
			await drainMosaicBootstrapMessages(pi as never);

			expect(pi.sent).toContainEqual({
				message: "Native followup",
				options: { deliverAs: "followUp", triggerTurn: true },
			});

			const beforeReply = server.currentSeq;
			await pi.handlers.message_end[0](
				{ message: { role: "assistant", content: [{ type: "text", text: "hello leader" }] } },
				{},
			);
			await expect(server.waitForUpdate({ afterSeq: beforeReply, timeoutMs: 10 })).resolves.toMatchObject({
				type: "agent_update",
				agentId: "agent-1",
				status: "completed",
				result: "hello leader",
			});
		} finally {
			await transport.close();
		}
	});

	test("publishes streamed assistant text before message_end", async () => {
		const server = new MosaicMessageServer({ now: () => 1000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		const transport = await startMosaicMessageTransport(server, { host: "127.0.0.1", port: 0 });
		try {
			process.env.MOSAIC_BOOTSTRAP_FILE = writeBootstrap({
				agentId: "agent-1",
				agentType: "Explore",
				description: "Review code",
				prompt: "Initial prompt",
				systemPrompt: "System prompt",
				builtinToolNames: ["read"],
				extensions: false,
				messageEndpoint: transport.endpoint,
				messageToken: token,
			});
			const pi = createFakePi();
			registerMosaicBootstrap(pi as never);

			await pi.handlers.session_start[0]({}, {});
			const beforeDelta = server.currentSeq;

			await pi.handlers.message_update[0](
				{ assistantMessageEvent: { type: "text_delta", delta: "alpha ready" } },
				{},
			);

			await expect(server.waitForUpdate({ afterSeq: beforeDelta, timeoutMs: 10 })).resolves.toMatchObject({
				type: "agent_update",
				agentId: "agent-1",
				status: "running",
				result: "alpha ready",
			});
		} finally {
			await transport.close();
		}
	});

	test("registers a child-only leader message tool and filters recursive lane tools", async () => {
		const server = new MosaicMessageServer({ now: () => 1000, id: () => "msg-1" });
		const { token } = server.registerAgent({ agentId: "agent-1", taskName: "reviewer" });
		const transport = await startMosaicMessageTransport(server, { host: "127.0.0.1", port: 0 });
		try {
			process.env.MOSAIC_BOOTSTRAP_FILE = writeBootstrap({
				agentId: "agent-1",
				agentType: "Explore",
				description: "Review code",
				prompt: "Initial prompt",
				systemPrompt: "System prompt",
				builtinToolNames: ["read"],
				extensions: false,
				messageEndpoint: transport.endpoint,
				messageToken: token,
			});
			const pi = createFakePi();
			registerMosaicBootstrap(pi as never);

			await pi.handlers.session_start[0]({}, {});

			expect(pi.activeTools).toContain(MOSAIC_LEADER_MESSAGE_TOOL_NAME);
			expect(pi.activeTools).not.toContain("spawn_map");
			const before = server.currentSeq;
			const tool = pi.tools.find((candidate) => candidate.name === MOSAIC_LEADER_MESSAGE_TOOL_NAME);
			await tool?.execute("tool-1", { message: "please clean up my session" });

			await expect(server.waitForUpdate({ afterSeq: before, timeoutMs: 10 })).resolves.toMatchObject({
				type: "agent_message",
				from: "agent-1",
				to: "leader",
				body: "please clean up my session",
			});
		} finally {
			await transport.close();
		}
	});
});

function writeBootstrap(payload: Record<string, unknown>): string {
	const path = join(tmpdir(), `${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(payload), "utf8");
	return path;
}

function createFakePi() {
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>> = {};
	const tools: Array<{ name: string; execute?: (toolCallId: string, params: any) => Promise<unknown> }> = [
		{ name: "read" },
		{ name: "write" },
		{ name: "spawn_map" },
	];
	return {
		handlers,
		tools,
		activeTools: [] as string[],
		sent: [] as Array<{ message: string; options?: unknown }>,
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
			handlers[event] ??= [];
			handlers[event].push(handler);
		},
		registerTool(tool: { name: string; execute?: (toolCallId: string, params: any) => Promise<unknown> }) {
			tools.push(tool);
		},
		setSessionName() {},
		getAllTools: () => tools,
		setActiveTools(next: string[]) {
			this.activeTools = next;
		},
		sendUserMessage(message: string, options?: unknown) {
			this.sent.push({ message, options });
		},
	};
}
