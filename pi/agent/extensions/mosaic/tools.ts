import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { highlightTrickle } from "./ui/animation.js";

export const MOSAIC_TOOL_NAMES = [
	"spawn_agent",
	"send_message",
	"followup_task",
	"wait_agent",
	"list_agents",
	"close_agent",
] as const;

export const DEFAULT_WAIT_AGENT_TIMEOUT_MS = 60_000;

export interface MosaicToolDeps {
	onToolContext?(ctx: unknown): void;
	spawnAgent(input: {
		taskName: string;
		message: string;
		agentType?: string;
		modelPreset?: string;
		model?: string;
		thinking?: string;
		mode?: "full-session" | "in-process";
		runInBackground?: boolean;
		isolation?: "worktree";
		cwd?: string;
		onTextDelta?: (fullText: string) => void;
	}): Promise<unknown>;
	sendMessage(input: { target: string; message: string; triggerTurn: boolean }): Promise<unknown>;
	waitAgent(input: { afterSeq?: number; timeoutMs?: number }): Promise<unknown>;
	listAgents(input: { pathPrefix?: string }): Promise<unknown>;
	closeAgent(input: { target: string }): Promise<unknown>;
}

interface SpawnAgentRenderDetails {
	taskName?: string;
	runtime?: string;
	background?: boolean;
	status?: string;
	result?: string;
	error?: string;
	responseText?: string;
}

function textResult(value: unknown, details?: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof value === "string" ? value : JSON.stringify(value ?? null),
			},
		],
		details,
	};
}

class EmptyMosaicRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyMosaicRender = new EmptyMosaicRender();

const INLINE_FRAME_MS = 120;
const INLINE_OUTPUT_BOX_LINES = 5;

interface InlineRenderState {
	startedAt?: number;
	timer?: ReturnType<typeof setTimeout>;
}

class InlineAgentRender implements Component {
	constructor(
		private readonly taskName: string,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
		private readonly startedAt: number,
		private readonly running: boolean,
	) {}

	render(width: number): string[] {
		const title = this.running
			? highlightTrickle("Agent", this.theme, Date.now() - this.startedAt)
			: `${this.theme.fg("success", "✓")} Agent`;
		const state = this.running ? "running inline" : "completed inline";
		const line = `${title} ${this.theme.fg("muted", this.taskName)} ${this.theme.fg("dim", state)}`;
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}

class InlineAgentOutputRender implements Component {
	constructor(
		private readonly output: string,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
	) {}

	render(width: number): string[] {
		return renderInlineOutputBox(this.output, this.theme, width);
	}

	invalidate(): void {}
}

function shouldRenderInlineSpawn(params: {
	mode?: "full-session" | "in-process";
	run_in_background?: boolean;
}): boolean {
	return params.mode !== "full-session" && params.run_in_background !== true;
}

function scheduleRenderInvalidation(
	context: { state?: InlineRenderState; invalidate?: () => void } | undefined,
	running: boolean,
): void {
	const state = context?.state;
	if (!state) return;
	if (!running) {
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
		return;
	}
	if (state.timer || !context?.invalidate) return;
	state.timer = setTimeout(() => {
		state.timer = undefined;
		context.invalidate?.();
	}, INLINE_FRAME_MS);
	if (typeof state.timer.unref === "function") state.timer.unref();
}

function inlineAgentRender(
	params: { task_name: string; mode?: "full-session" | "in-process"; run_in_background?: boolean },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
	context?: { state?: InlineRenderState; isPartial?: boolean; invalidate?: () => void },
): Component {
	if (!shouldRenderInlineSpawn(params)) return emptyMosaicRender;
	let state: InlineRenderState = {};
	if (context) {
		context.state ??= {};
		state = context.state;
	}
	state.startedAt ??= Date.now();
	const running = context?.isPartial === true;
	scheduleRenderInvalidation(context, running);
	return new InlineAgentRender(params.task_name, theme, state.startedAt, running);
}

function getSpawnRenderDetails(result: { details?: unknown }): SpawnAgentRenderDetails | undefined {
	const details = result.details;
	if (!details || typeof details !== "object") return undefined;
	return details as SpawnAgentRenderDetails;
}

function spawnAgentResultRender(
	result: { details?: unknown },
	theme: { fg(color: string, text: string): string; bold(text: string): string },
): Component {
	const details = getSpawnRenderDetails(result);
	if (details?.background !== false || details.runtime !== "in-process") return emptyMosaicRender;
	return new InlineAgentOutputRender(details.responseText ?? details.result ?? "", theme);
}

function renderInlineOutputBox(
	output: string,
	theme: { fg(color: string, text: string): string },
	width: number,
): string[] {
	const safeWidth = Math.max(10, width);
	const innerWidth = Math.max(1, safeWidth - 4);
	const visibleLines = normalizeOutputLines(output).slice(-3);
	while (visibleLines.length < 3) visibleLines.unshift("");
	const top = `${theme.fg("dim", "  ┌")}${theme.fg("dim", "─".repeat(innerWidth))}${theme.fg("dim", "┐")}`;
	const bottom = `${theme.fg("dim", "  └")}${theme.fg("dim", "─".repeat(innerWidth))}${theme.fg("dim", "┘")}`;
	return [
		truncateToWidth(top, safeWidth),
		...visibleLines.map((line) => {
			const text = line || "(waiting for output)";
			const truncated = truncateToWidth(text, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return `${theme.fg("dim", "  │")}${theme.fg(line ? "dim" : "muted", truncated)}${" ".repeat(padding)}${theme.fg("dim", "│")}`;
		}),
		truncateToWidth(bottom, safeWidth),
	].slice(0, INLINE_OUTPUT_BOX_LINES);
}

function normalizeOutputLines(output: string): string[] {
	const trimmed = output.replace(/\n$/, "");
	if (!trimmed) return [];
	return trimmed.split("\n").map((line) => line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " "));
}

export function createMosaicTools(deps: MosaicToolDeps) {
	return [
		defineTool({
			name: "spawn_agent",
			label: "Spawn Agent",
			description: "Start a named mosaic agent task.",
			parameters: Type.Object({
				task_name: Type.String({ description: "Stable target name." }),
				message: Type.String({ description: "Initial task message." }),
				agent_type: Type.Optional(Type.String({ description: "Agent type." })),
				model_preset: Type.Optional(Type.String({ description: "Optional model preset." })),
				model: Type.Optional(Type.String({ description: "Optional model." })),
				thinking: Type.Optional(Type.String({ description: "Thinking level." })),
				mode: Type.Optional(
					Type.Union([Type.Literal("full-session"), Type.Literal("in-process")], {
						description: "Omit for in-process; full-session opens a visible mosaic target.",
					}),
				),
				run_in_background: Type.Optional(
					Type.Boolean({
						description: "For in-process: true returns immediately, false waits inline. Defaults false.",
					}),
				),
				isolation: Type.Optional(Type.Literal("worktree", { description: "Use a worktree." })),
				cwd: Type.Optional(
					Type.String({
						description: "Working directory for the agent. Absolute or relative to the parent session cwd.",
					}),
				),
			}),
			renderShell: "self" as const,
			renderCall: (params, theme, context) => inlineAgentRender(params, theme, context),
			renderResult: (result, _options, theme) => spawnAgentResultRender(result, theme),
			execute: async (_toolCallId, params, _signal, onUpdate, ctx) => {
				deps.onToolContext?.(ctx);
				const result = await deps.spawnAgent({
					taskName: params.task_name,
					message: params.message,
					agentType: params.agent_type,
					modelPreset: params.model_preset,
					model: params.model,
					thinking: params.thinking,
					mode: params.mode,
					runInBackground: params.run_in_background,
					isolation: params.isolation,
					cwd: params.cwd,
					onTextDelta: (fullText) => {
						onUpdate?.(
							textResult(fullText, {
								taskName: params.task_name,
								runtime: "in-process",
								background: false,
								status: "running",
								responseText: fullText,
							}),
						);
					},
				});
				return textResult(result, result);
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
