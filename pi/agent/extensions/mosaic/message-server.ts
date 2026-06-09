import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export type MosaicMessageKind = "message" | "followup_task";
export type MosaicAgentStatus = "registered" | "running" | "completed" | "error" | "disconnected" | "closed";

export interface MosaicAgentRegistration {
	agentId: string;
	taskName?: string;
	type?: string;
	description?: string;
}

export interface MosaicAgentConnection {
	agentId: string;
	token: string;
	connected: boolean;
}

export interface MosaicMailboxMessage {
	type: "mailbox_message";
	id: string;
	seq: number;
	from: "leader";
	to: string;
	kind: MosaicMessageKind;
	body: string;
	triggerTurn: boolean;
	createdAt: number;
}

export interface MosaicAgentUpdate {
	type: "agent_update";
	seq: number;
	agentId: string;
	status: MosaicAgentStatus;
	activity?: string;
	result?: string;
	error?: string;
	createdAt: number;
}

export interface MosaicAgentLeaderMessage {
	type: "agent_message";
	seq: number;
	from: string;
	to: "leader";
	body: string;
	createdAt: number;
}

export type MosaicControlUpdate = MosaicMailboxMessage | MosaicAgentUpdate | MosaicAgentLeaderMessage;
export const MOSAIC_AGENT_ACTIVITY_WRITING = "writing";

export interface EnqueueMessageInput {
	body: string;
	triggerTurn: boolean;
}

export interface AgentUpdateInput {
	status: Exclude<MosaicAgentStatus, "registered" | "disconnected" | "closed">;
	activity?: string;
	result?: string;
	error?: string;
}

export interface MosaicAgentSnapshot {
	agentId: string;
	taskName?: string;
	type?: string;
	description?: string;
	connected: boolean;
	closed: boolean;
	status: MosaicAgentStatus;
	lastSeq: number;
	createdAt: number;
	updatedAt: number;
}

interface AgentState extends MosaicAgentSnapshot {
	token: string;
	mailbox: MosaicMailboxMessage[];
	lastUpdate?: MosaicAgentUpdate;
}

interface Waiter {
	afterSeq: number;
	resolve: (update: MosaicControlUpdate | undefined) => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface MessageServerOptions {
	now?: () => number;
	id?: () => string;
	token?: () => string;
}

type UpdateListener = (update: MosaicControlUpdate) => void;

export type MosaicTransportRequest =
	| { id: string; method: "connect"; agentId: string; token: string }
	| { id: string; method: "drain"; agentId: string; token: string }
	| { id: string; method: "ack"; agentId: string; token: string; messageIds: string[] }
	| { id: string; method: "update"; agentId: string; token: string; update: AgentUpdateInput }
	| { id: string; method: "leader_message"; agentId: string; token: string; body: string }
	| { id: string; method: "disconnect"; agentId: string; token: string };

export type MosaicTransportResponse =
	| { id: string; ok: true; data?: unknown }
	| { id: string; ok: false; error: string };

export interface MosaicMessageTransport {
	endpoint: string;
	close: () => Promise<void>;
}

export interface MosaicMessageTransportOptions {
	host?: string;
	port?: number;
}

export class MosaicMessageServer {
	private static readonly MAX_UPDATES = 1000;
	private readonly now: () => number;
	private readonly id: () => string;
	private readonly token: () => string;
	private readonly agents = new Map<string, AgentState>();
	private readonly taskNameIndex = new Map<string, string>();
	private readonly updates: MosaicControlUpdate[] = [];
	private readonly waiters: Waiter[] = [];
	private readonly updateListeners = new Set<UpdateListener>();
	private seq = 0;

	constructor(options: MessageServerOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.id = options.id ?? (() => randomUUID());
		this.token = options.token ?? (() => randomBytes(16).toString("hex"));
	}

	get currentSeq(): number {
		return this.seq;
	}

	registerAgent(input: MosaicAgentRegistration): MosaicAgentConnection {
		if (this.agents.has(input.agentId)) {
			throw new Error(`agent already registered: ${input.agentId}`);
		}
		if (input.taskName) {
			const existingId = this.taskNameIndex.get(input.taskName);
			const existing = existingId ? this.agents.get(existingId) : undefined;
			if (existing && !existing.closed) throw new Error(`task name already registered: ${input.taskName}`);
			if (existing?.closed) this.taskNameIndex.delete(input.taskName);
		}

		const createdAt = this.now();
		const state: AgentState = {
			agentId: input.agentId,
			taskName: input.taskName,
			type: input.type,
			description: input.description,
			token: this.token(),
			connected: false,
			closed: false,
			status: "registered",
			lastSeq: this.nextSeq(),
			createdAt,
			updatedAt: createdAt,
			mailbox: [],
		};
		this.agents.set(state.agentId, state);
		if (state.taskName) this.taskNameIndex.set(state.taskName, state.agentId);
		return { agentId: state.agentId, token: state.token, connected: state.connected };
	}

	connectAgent(agentId: string, token: string): MosaicAgentConnection {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		if (agent.closed) throw new Error(`agent is closed: ${agentId}`);
		agent.connected = true;
		agent.updatedAt = this.now();
		return { agentId: agent.agentId, token: agent.token, connected: true };
	}

	enqueueMessage(target: string, input: EnqueueMessageInput): MosaicMailboxMessage {
		const agent = this.requireTarget(target);
		if (agent.closed) throw new Error(`agent is closed: ${agent.agentId}`);
		const message: MosaicMailboxMessage = {
			type: "mailbox_message",
			id: this.id(),
			seq: this.nextSeq(),
			from: "leader",
			to: agent.agentId,
			kind: input.triggerTurn ? "followup_task" : "message",
			body: input.body,
			triggerTurn: input.triggerTurn,
			createdAt: this.now(),
		};
		agent.mailbox.push(message);
		this.recordUpdate(message);
		this.touch(agent, message.seq, message.createdAt);
		return message;
	}

	drainMessages(agentId: string, token: string): MosaicMailboxMessage[] {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		return [...agent.mailbox];
	}

	ackMessages(agentId: string, token: string, messageIds: string[]): { acknowledged: number } {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		const ids = new Set(messageIds);
		const before = agent.mailbox.length;
		agent.mailbox = agent.mailbox.filter((message) => !ids.has(message.id));
		return { acknowledged: before - agent.mailbox.length };
	}

	recordAgentUpdate(agentId: string, token: string, input: AgentUpdateInput): MosaicAgentUpdate {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		if (agent.closed) throw new Error(`agent is closed: ${agentId}`);
		return this.updateAgent(agent, {
			status: input.status,
			activity: input.activity,
			result: input.result,
			error: input.error,
		});
	}

	recordLeaderMessage(agentId: string, token: string, body: string): MosaicAgentLeaderMessage {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		if (agent.closed) throw new Error(`agent is closed: ${agentId}`);
		const message: MosaicAgentLeaderMessage = {
			type: "agent_message",
			seq: this.nextSeq(),
			from: agent.agentId,
			to: "leader",
			body,
			createdAt: this.now(),
		};
		this.recordUpdate(message);
		this.touch(agent, message.seq, message.createdAt);
		return message;
	}

	disconnectAgent(agentId: string, token: string): MosaicAgentUpdate {
		const agent = this.requireAgent(agentId);
		this.assertToken(agent, token);
		agent.connected = false;
		if (isTerminalAgentStatus(agent.status)) return this.snapshotAgentUpdate(agent);
		return this.updateAgent(agent, { status: "disconnected" });
	}

	closeAgent(target: string, result?: string): MosaicAgentUpdate {
		const agent = this.requireTarget(target);
		agent.connected = false;
		agent.closed = true;
		agent.mailbox = [];
		if (agent.taskName && this.taskNameIndex.get(agent.taskName) === agent.agentId) {
			this.taskNameIndex.delete(agent.taskName);
		}
		return this.updateAgent(agent, { status: "closed", result });
	}

	removeAgent(agentId: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) return;
		if (agent.taskName && this.taskNameIndex.get(agent.taskName) === agent.agentId) {
			this.taskNameIndex.delete(agent.taskName);
		}
		this.agents.delete(agentId);
	}

	waitForUpdate(input: { afterSeq: number; timeoutMs?: number }): Promise<MosaicControlUpdate | undefined> {
		const existing = this.updates.find((update) => update.seq > input.afterSeq);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				afterSeq: input.afterSeq,
				resolve,
			};
			if (input.timeoutMs != null) {
				waiter.timer = setTimeout(() => {
					this.removeWaiter(waiter);
					resolve(undefined);
				}, input.timeoutMs);
				waiter.timer.unref?.();
			}
			this.waiters.push(waiter);
		});
	}

	listUpdates(): MosaicControlUpdate[] {
		return [...this.updates];
	}

	listAgents(): MosaicAgentSnapshot[] {
		return [...this.agents.values()].map(
			({ token: _token, mailbox: _mailbox, lastUpdate: _lastUpdate, ...snapshot }) => ({
				...snapshot,
			}),
		);
	}

	onUpdate(listener: UpdateListener): () => void {
		this.updateListeners.add(listener);
		return () => {
			this.updateListeners.delete(listener);
		};
	}

	private updateAgent(
		agent: AgentState,
		input: Pick<MosaicAgentUpdate, "status" | "activity" | "result" | "error">,
	): MosaicAgentUpdate {
		if (isTerminalAgentStatus(agent.status) && input.status !== "closed") {
			return this.snapshotAgentUpdate(agent);
		}
		if (isCoalescibleWritingProgress(agent, input)) {
			const now = this.now();
			agent.lastUpdate = {
				...agent.lastUpdate,
				activity: input.activity,
				result: input.result,
				error: input.error,
				createdAt: now,
			};
			agent.updatedAt = now;
			return this.snapshotAgentUpdate(agent);
		}
		const update: MosaicAgentUpdate = {
			type: "agent_update",
			seq: this.nextSeq(),
			agentId: agent.agentId,
			status: input.status,
			activity: input.activity,
			result: input.result,
			error: input.error,
			createdAt: this.now(),
		};
		agent.status = update.status;
		agent.lastUpdate = update;
		this.recordUpdate(update);
		this.touch(agent, update.seq, update.createdAt);
		return update;
	}

	private snapshotAgentUpdate(agent: AgentState): MosaicAgentUpdate {
		return (
			agent.lastUpdate ?? {
				type: "agent_update",
				seq: agent.lastSeq,
				agentId: agent.agentId,
				status: agent.status,
				createdAt: agent.updatedAt,
			}
		);
	}

	private recordUpdate(update: MosaicControlUpdate): void {
		this.updates.push(update);
		if (this.updates.length > MosaicMessageServer.MAX_UPDATES) {
			this.updates.splice(0, this.updates.length - MosaicMessageServer.MAX_UPDATES);
		}
		for (const waiter of [...this.waiters]) {
			if (update.seq <= waiter.afterSeq) continue;
			this.removeWaiter(waiter);
			waiter.resolve(update);
		}
		for (const listener of [...this.updateListeners]) {
			listener(update);
		}
	}

	private nextSeq(): number {
		this.seq++;
		return this.seq;
	}

	private touch(agent: AgentState, seq: number, now: number): void {
		agent.lastSeq = seq;
		agent.updatedAt = now;
	}

	private removeWaiter(waiter: Waiter): void {
		const index = this.waiters.indexOf(waiter);
		if (index !== -1) this.waiters.splice(index, 1);
		if (waiter.timer) clearTimeout(waiter.timer);
	}

	private requireTarget(target: string): AgentState {
		return this.requireAgent(this.taskNameIndex.get(target) ?? target);
	}

	private requireAgent(agentId: string): AgentState {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`agent not found: ${agentId}`);
		return agent;
	}

	private assertToken(agent: AgentState, token: string): void {
		if (agent.token !== token) throw new Error(`invalid token for agent: ${agent.agentId}`);
	}
}

export async function startMosaicMessageTransport(
	mailbox: MosaicMessageServer,
	options: MosaicMessageTransportOptions = {},
): Promise<MosaicMessageTransport> {
	const host = options.host ?? "127.0.0.1";
	const server = createServer((socket) => handleSocket(mailbox, socket));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeServer(server);
		throw new Error("failed to start mosaic message transport");
	}
	return {
		endpoint: `tcp://${address.address}:${address.port}`,
		close: () => closeServer(server),
	};
}

function handleSocket(mailbox: MosaicMessageServer, socket: Socket): void {
	const maxRequestBytes = 64 * 1024;
	let buffer = "";
	socket.setEncoding("utf8");
	socket.setTimeout(30_000, () => socket.destroy());
	socket.on("error", () => {
		// Peers can disappear when a child pane is closed; transport errors are
		// reflected by missed updates, not process-level crashes.
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		if (buffer.length > maxRequestBytes) {
			writeResponse(socket, { id: "unknown", ok: false, error: "mosaic request is too large" });
			socket.destroy();
			return;
		}
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			writeResponse(socket, handleTransportRequest(mailbox, line));
		}
	});
}

function handleTransportRequest(mailbox: MosaicMessageServer, line: string): MosaicTransportResponse {
	let request: MosaicTransportRequest;
	try {
		request = JSON.parse(line) as MosaicTransportRequest;
	} catch (err) {
		return { id: "unknown", ok: false, error: err instanceof Error ? err.message : String(err) };
	}

	try {
		switch (request.method) {
			case "connect":
				return { id: request.id, ok: true, data: mailbox.connectAgent(request.agentId, request.token) };
			case "drain":
				return { id: request.id, ok: true, data: mailbox.drainMessages(request.agentId, request.token) };
			case "ack":
				return {
					id: request.id,
					ok: true,
					data: mailbox.ackMessages(request.agentId, request.token, request.messageIds),
				};
			case "update":
				return {
					id: request.id,
					ok: true,
					data: mailbox.recordAgentUpdate(request.agentId, request.token, request.update),
				};
			case "leader_message":
				return {
					id: request.id,
					ok: true,
					data: mailbox.recordLeaderMessage(request.agentId, request.token, request.body),
				};
			case "disconnect":
				return { id: request.id, ok: true, data: mailbox.disconnectAgent(request.agentId, request.token) };
			default:
				return { id: request.id, ok: false, error: `unknown mosaic transport method: ${(request as any).method}` };
		}
	} catch (err) {
		return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function writeResponse(socket: Socket, response: MosaicTransportResponse): void {
	socket.write(`${JSON.stringify(response)}\n`);
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function isTerminalAgentStatus(status: MosaicAgentStatus): boolean {
	return status === "completed" || status === "error" || status === "closed";
}

function isCoalescibleWritingProgress(
	agent: AgentState,
	input: Pick<MosaicAgentUpdate, "status" | "activity" | "result" | "error">,
): boolean {
	return (
		input.status === "running" &&
		input.activity === MOSAIC_AGENT_ACTIVITY_WRITING &&
		agent.lastUpdate?.status === "running" &&
		agent.lastUpdate.activity === MOSAIC_AGENT_ACTIVITY_WRITING
	);
}
