import { connect } from "node:net";
import type {
	AgentUpdateInput,
	MosaicAgentConnection,
	MosaicAgentLeaderMessage,
	MosaicAgentUpdate,
	MosaicMailboxMessage,
	MosaicTransportRequest,
	MosaicTransportResponse,
} from "./message-server";

export interface MosaicMessageClientOptions {
	endpoint: string;
	agentId: string;
	token: string;
}

type MosaicMessageClientRequest = MosaicTransportRequest;

type MosaicMessageClientResponse<T> =
	| (Extract<MosaicTransportResponse, { ok: true }> & { data: T })
	| Extract<MosaicTransportResponse, { ok: false }>;

let nextRequestId = 0;

export class MosaicMessageClient {
	private readonly endpoint: string;
	private readonly agentId: string;
	private readonly token: string;

	constructor(options: MosaicMessageClientOptions) {
		this.endpoint = options.endpoint;
		this.agentId = options.agentId;
		this.token = options.token;
	}

	connect(): Promise<MosaicAgentConnection> {
		return this.request<MosaicAgentConnection>({ method: "connect" });
	}

	drainMessages(): Promise<MosaicMailboxMessage[]> {
		return this.request<MosaicMailboxMessage[]>({ method: "drain" });
	}

	ackMessages(messageIds: string[]): Promise<{ acknowledged: number }> {
		return this.request<{ acknowledged: number }>({ method: "ack", messageIds });
	}

	recordUpdate(update: AgentUpdateInput): Promise<MosaicAgentUpdate> {
		return this.request<MosaicAgentUpdate>({ method: "update", update });
	}

	sendLeaderMessage(body: string): Promise<MosaicAgentLeaderMessage> {
		return this.request<MosaicAgentLeaderMessage>({ method: "leader_message", body });
	}

	disconnect(): Promise<MosaicAgentUpdate> {
		return this.request<MosaicAgentUpdate>({ method: "disconnect" });
	}

	private async request<T>(input: Omit<MosaicMessageClientRequest, "id" | "agentId" | "token">): Promise<T> {
		const response = await sendRequest<T>(this.endpoint, {
			...input,
			id: `mosaic-${++nextRequestId}`,
			agentId: this.agentId,
			token: this.token,
		} as MosaicTransportRequest);
		if (!response.ok) throw new Error(response.error);
		return response.data;
	}
}

export interface MailboxDrainClient {
	drainMessages(): Promise<Array<Pick<MosaicMailboxMessage, "id" | "body" | "triggerTurn">>>;
	ackMessages?(messageIds: string[]): Promise<unknown>;
}

export interface UserMessageSender {
	sendUserMessage(message: string, options?: { deliverAs: "followUp"; triggerTurn?: true }): void;
}

export async function deliverMosaicMailboxMessages(client: MailboxDrainClient, pi: UserMessageSender): Promise<number> {
	const messages = await client.drainMessages();
	for (const message of messages) {
		pi.sendUserMessage(
			message.body,
			message.triggerTurn ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "followUp" },
		);
	}
	await client.ackMessages?.(
		messages
			.map((message) => ("id" in message && typeof message.id === "string" ? message.id : undefined))
			.filter((id): id is string => Boolean(id)),
	);
	return messages.length;
}

async function sendRequest<T>(
	endpoint: string,
	payload: MosaicMessageClientRequest,
): Promise<MosaicMessageClientResponse<T>> {
	const url = new URL(endpoint);
	if (url.protocol !== "tcp:") throw new Error(`unsupported mosaic message endpoint: ${url.protocol}`);
	return new Promise((resolve, reject) => {
		const socket = connect({ host: url.hostname, port: Number(url.port) });
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			socket.end();
			resolve(JSON.parse(line) as MosaicMessageClientResponse<T>);
		});
		socket.on("error", reject);
	});
}
