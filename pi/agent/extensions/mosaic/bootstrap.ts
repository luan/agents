import { readFileSync, unlinkSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deliverMosaicMailboxMessages, MosaicMessageClient } from "./message-client.js";
import { MOSAIC_AGENT_ACTIVITY_WRITING } from "./message-server.js";
import { isMosaicOrchestrationToolName } from "./orchestration-tools.js";

export const MOSAIC_LEADER_MESSAGE_TOOL_NAME = "message_leader";

export interface MosaicBootstrapPayload {
	agentId: string;
	agentType: string;
	description: string;
	prompt: string;
	systemPrompt: string;
	builtinToolNames: string[];
	extensions: true | string[] | false;
	disallowedTools?: string[];
	mosaicIdentity?: {
		label: string;
		name: string;
		color: string;
	};
	messageEndpoint?: string;
	messageToken?: string;
}

let bootstrap: MosaicBootstrapPayload | undefined;
let systemPromptForFirstTurn: string | undefined;
let sentPrompt = false;
let messageClient: MosaicMessageClient | undefined;
let messagePoller: ReturnType<typeof setInterval> | undefined;
let currentAssistantText = "";
let lastPublishedAssistantText = "";
let leaderMessageToolRegistered = false;

export function getMosaicBootstrapMetadata() {
	return bootstrap
		? {
				agentId: bootstrap.agentId,
				agentType: bootstrap.agentType,
				agentDescription: bootstrap.description,
				mosaicAgentLabel: bootstrap.mosaicIdentity?.label,
				mosaicAgentName: bootstrap.mosaicIdentity?.name,
				mosaicAgentColor: bootstrap.mosaicIdentity?.color,
			}
		: {};
}

export function isMosaicChildSession(): boolean {
	return Boolean(bootstrap || process.env.MOSAIC_BOOTSTRAP_FILE);
}

export function registerMosaicBootstrap(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		loadBootstrap();
		if (!bootstrap || sentPrompt) return;

		pi.setSessionName(bootstrap.description);
		registerLeaderMessageTool(pi, bootstrap);
		applyActiveTools(pi, bootstrap);
		systemPromptForFirstTurn = bootstrap.systemPrompt;
		messageClient = await connectMosaicMessageClient(bootstrap);
		startMessagePolling(pi);
		sentPrompt = true;

		setTimeout(() => {
			pi.sendUserMessage(bootstrap?.prompt ?? "");
		}, 0);
	});

	pi.on("before_agent_start", async () => {
		if (!systemPromptForFirstTurn) return;
		const systemPrompt = systemPromptForFirstTurn;
		systemPromptForFirstTurn = undefined;
		return { systemPrompt };
	});

	pi.on("message_end", async (event) => {
		if (!messageClient) return;
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role !== "assistant") return;
		await publishAssistantResult("completed", messageText(message.content));
	});

	pi.on("message_update", async (event) => {
		const update = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
		if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
		currentAssistantText += update.delta;
		await publishAssistantResult("running", currentAssistantText);
	});

	pi.on("message_start", async () => {
		currentAssistantText = "";
		lastPublishedAssistantText = "";
	});

	(pi.on as any)("session_shutdown", () => {
		stopMessagePolling();
		messageClient?.disconnect().catch(() => {});
		messageClient = undefined;
	});
}

export async function drainMosaicBootstrapMessages(pi: ExtensionAPI): Promise<number> {
	if (!messageClient) return 0;
	return deliverMosaicMailboxMessages(messageClient, pi);
}

function loadBootstrap(): void {
	if (bootstrap) return;
	const path = process.env.MOSAIC_BOOTSTRAP_FILE;
	if (!path) return;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MosaicBootstrapPayload>;
		if (
			typeof parsed.agentId === "string" &&
			typeof parsed.agentType === "string" &&
			typeof parsed.description === "string" &&
			typeof parsed.prompt === "string" &&
			typeof parsed.systemPrompt === "string" &&
			Array.isArray(parsed.builtinToolNames)
		) {
			bootstrap = {
				agentId: parsed.agentId,
				agentType: parsed.agentType,
				description: parsed.description,
				prompt: parsed.prompt,
				systemPrompt: parsed.systemPrompt,
				builtinToolNames: parsed.builtinToolNames.filter((name): name is string => typeof name === "string"),
				extensions: normalizeExtensions(parsed.extensions),
				disallowedTools: Array.isArray(parsed.disallowedTools)
					? parsed.disallowedTools.filter((name): name is string => typeof name === "string")
					: undefined,
				mosaicIdentity: normalizeMosaicIdentity(parsed.mosaicIdentity),
				messageEndpoint: typeof parsed.messageEndpoint === "string" ? parsed.messageEndpoint : undefined,
				messageToken: typeof parsed.messageToken === "string" ? parsed.messageToken : undefined,
			};
		}
	} catch {
		// A bad bootstrap file should not prevent a manually opened mosaic session.
	} finally {
		try {
			unlinkSync(path);
		} catch {}
	}
}

function normalizeMosaicIdentity(value: unknown): MosaicBootstrapPayload["mosaicIdentity"] {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as { label?: unknown; name?: unknown; color?: unknown };
	if (typeof raw.label !== "string" || typeof raw.name !== "string" || typeof raw.color !== "string") {
		return undefined;
	}
	const label = raw.label.trim();
	const name = raw.name.trim();
	const color = raw.color.trim();
	if (!label || !name || !color) return undefined;
	return { label, name, color };
}

function normalizeExtensions(value: unknown): true | string[] | false {
	if (value === false) return false;
	if (Array.isArray(value)) return value.filter((name): name is string => typeof name === "string");
	return true;
}

function applyActiveTools(pi: ExtensionAPI, payload: MosaicBootstrapPayload): void {
	const builtin = new Set(payload.builtinToolNames);
	const disallowed = new Set(payload.disallowedTools ?? []);
	const allToolNames = pi.getAllTools().map((tool) => tool.name);
	const next = allToolNames.filter((toolName) => {
		if (isMosaicOrchestrationToolName(toolName) || disallowed.has(toolName)) return false;
		if (toolName === MOSAIC_LEADER_MESSAGE_TOOL_NAME && payload.messageEndpoint) return true;
		if (builtin.has(toolName)) return true;
		if (payload.extensions === false) return false;
		if (Array.isArray(payload.extensions)) {
			return payload.extensions.some((extension) => toolName.startsWith(extension) || toolName.includes(extension));
		}
		return true;
	});
	pi.setActiveTools(next);
}

class EmptyLeaderMessageRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyLeaderMessageRender = new EmptyLeaderMessageRender();

function registerLeaderMessageTool(pi: ExtensionAPI, payload: MosaicBootstrapPayload): void {
	if (!payload.messageEndpoint || leaderMessageToolRegistered) return;
	pi.registerTool(
		defineTool({
			name: MOSAIC_LEADER_MESSAGE_TOOL_NAME,
			label: "Message Leader",
			description: "Send a message from this mosaic agent to its leader.",
			parameters: Type.Object({
				message: Type.String({ description: "Message for the leader." }),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyLeaderMessageRender,
			renderResult: () => emptyLeaderMessageRender,
			execute: async (_toolCallId, params) => {
				if (!messageClient) throw new Error("mosaic leader channel is not connected");
				const sent = await messageClient.sendLeaderMessage(params.message);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(sent),
						},
					],
				};
			},
		}),
	);
	leaderMessageToolRegistered = true;
}

async function connectMosaicMessageClient(payload: MosaicBootstrapPayload): Promise<MosaicMessageClient | undefined> {
	if (!payload.messageEndpoint || !payload.messageToken) return undefined;
	const client = new MosaicMessageClient({
		endpoint: payload.messageEndpoint,
		agentId: payload.agentId,
		token: payload.messageToken,
	});
	await client.connect();
	await client.recordUpdate({ status: "running", activity: "connected" });
	return client;
}

function startMessagePolling(pi: ExtensionAPI): void {
	if (!messageClient || messagePoller) return;
	messagePoller = setInterval(() => {
		drainMosaicBootstrapMessages(pi).catch(() => {});
	}, 250);
	messagePoller.unref?.();
}

function stopMessagePolling(): void {
	if (!messagePoller) return;
	clearInterval(messagePoller);
	messagePoller = undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item && typeof item === "object" && "text" in item ? String(item.text ?? "") : ""))
		.join("");
}

async function publishAssistantResult(status: "running" | "completed", result: string): Promise<void> {
	const text = result.trim();
	const dedupeKey = `${status}:${text}`;
	if (!messageClient || !text || dedupeKey === lastPublishedAssistantText) return;
	lastPublishedAssistantText = dedupeKey;
	await messageClient.recordUpdate({
		status,
		activity: status === "running" ? MOSAIC_AGENT_ACTIVITY_WRITING : undefined,
		result: text,
	});
}

export function __resetMosaicBootstrapForTest(): void {
	bootstrap = undefined;
	systemPromptForFirstTurn = undefined;
	sentPrompt = false;
	messageClient = undefined;
	stopMessagePolling();
	currentAssistantText = "";
	lastPublishedAssistantText = "";
	leaderMessageToolRegistered = false;
}
