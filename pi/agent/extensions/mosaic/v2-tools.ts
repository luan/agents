import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const MOSAIC_V2_TOOL_NAMES = [
	"spawn_agent",
	"send_message",
	"followup_task",
	"wait_agent",
	"list_agents",
	"close_agent",
] as const;

export const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 60_000;

export interface MosaicV2ToolDeps {
	onToolContext?(ctx: unknown): void;
	spawnAgent(input: {
		taskName: string;
		message: string;
		agentType?: string;
		model?: string;
		thinking?: string;
		isolation?: "worktree";
	}): Promise<unknown>;
	sendMessage(input: { target: string; message: string; triggerTurn: boolean }): Promise<unknown>;
	waitAgent(input: { afterSeq?: number; timeoutMs?: number }): Promise<unknown>;
	listAgents(input: { pathPrefix?: string }): Promise<unknown>;
	closeAgent(input: { target: string }): Promise<unknown>;
}

function textResult(value: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof value === "string" ? value : JSON.stringify(value ?? null),
			},
		],
	};
}

class EmptyMosaicRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyMosaicRender = new EmptyMosaicRender();

export function createMosaicV2Tools(deps: MosaicV2ToolDeps) {
	return [
		defineTool({
			name: "spawn_agent",
			label: "Spawn Agent",
			description: "Start a named mosaic agent task.",
			parameters: Type.Object({
				task_name: Type.String({ description: "Stable target name." }),
				message: Type.String({ description: "Initial task message." }),
				agent_type: Type.Optional(Type.String({ description: "Agent type." })),
				model: Type.Optional(Type.String({ description: "Optional model." })),
				thinking: Type.Optional(Type.String({ description: "Thinking level." })),
				isolation: Type.Optional(Type.Literal("worktree", { description: "Use a worktree." })),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(
					await deps.spawnAgent({
						taskName: params.task_name,
						message: params.message,
						agentType: params.agent_type,
						model: params.model,
						thinking: params.thinking,
						isolation: params.isolation,
					}),
				);
			},
		}),
		defineTool({
			name: "send_message",
			label: "Send Message",
			description: "Queue a message for an agent.",
			parameters: Type.Object({
				target: Type.String({ description: "Task name or agent id." }),
				message: Type.String({ description: "Message body." }),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(
					await deps.sendMessage({ target: params.target, message: params.message, triggerTurn: false }),
				);
			},
		}),
		defineTool({
			name: "followup_task",
			label: "Follow-up Task",
			description: "Queue work and trigger an agent turn.",
			parameters: Type.Object({
				target: Type.String({ description: "Task name or agent id." }),
				message: Type.String({ description: "Task body." }),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(
					await deps.sendMessage({ target: params.target, message: params.message, triggerTurn: true }),
				);
			},
		}),
		defineTool({
			name: "wait_agent",
			label: "Wait Agent",
			description: "Wait for the next mosaic agent update.",
			parameters: Type.Object({
				after_seq: Type.Optional(Type.Number({ description: "Last seen sequence." })),
				timeout_ms: Type.Optional(Type.Number({ description: "Max wait time." })),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(
					await deps.waitAgent({
						afterSeq: params.after_seq,
						timeoutMs: params.timeout_ms ?? DEFAULT_WAIT_AGENT_TIMEOUT_MS,
					}),
				);
			},
		}),
		defineTool({
			name: "list_agents",
			label: "List Agents",
			description: "List mosaic agents.",
			parameters: Type.Object({
				path_prefix: Type.Optional(Type.String({ description: "Optional task prefix." })),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(await deps.listAgents({ pathPrefix: params.path_prefix }));
			},
		}),
		defineTool({
			name: "close_agent",
			label: "Close Agent",
			description: "Close a mosaic agent.",
			parameters: Type.Object({
				target: Type.String({ description: "Task name or agent id." }),
			}),
			renderShell: "self" as const,
			renderCall: () => emptyMosaicRender,
			renderResult: () => emptyMosaicRender,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				return textResult(await deps.closeAgent({ target: params.target }));
			},
		}),
	];
}

export function isMosaicV2ToolsEnabled(): boolean {
	return process.env.MOSAIC_V2_TOOLS !== "0";
}
