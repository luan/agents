import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
import { approxTokenCount, estimateImageTokens } from "../shared/output-budget.ts";
import { sessionIdFromContext } from "../shared/session-context.ts";
import { retainedImagesFor } from "../shared/tool-result-images.ts";
import { getToolPolicy } from "../tool-policy/policy.ts";
import type { BasePromptTraceResult } from "./base-trace/index.js";
import { attributeBasePrompt, extractBaseLines, extractContributions } from "./base-trace/index.js";
import type { LoadedExtension } from "./base-trace/types.js";
import { buildToolDefinitionsSection, parseSystemPrompt } from "./parser.js";
import { showReport } from "./report-view.js";
import { loadAllSkills } from "./skills.js";
import { applyChanges, loadSettings } from "./skills-persistence.js";
import { parseDeclaredToolNames, toolReachResolver } from "./tool-reach.ts";
import {
	DisableMode,
	type SessionUsageCategory,
	type SessionUsageData,
	type ToolReach,
	type TurnUsage,
} from "./types.js";
import { readTurnUsage, summarizeTurns } from "./usage.ts";

// Matches pi's own resolution: PI_CODING_AGENT_DIR first, then ~/.pi/agent.
function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") {
			return os.homedir();
		}
		if (envDir.startsWith("~/")) {
			return path.join(os.homedir(), envDir.slice(2));
		}
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function contentRecords(content: unknown): readonly Record<string, unknown>[] {
	return Array.isArray(content)
		? content.filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
		: [];
}

// A renderer splices images out of the array the session entry holds, so a drawn tool result shows none of them.
function estimateContentTokens(content: unknown, toolCallId?: string): number {
	if (typeof content === "string") {
		return approxTokenCount(content);
	}

	let tokens = 0;
	let sawImage = false;
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			tokens += approxTokenCount(part.text);
		} else if (part.type === "image") {
			sawImage = true;
			tokens += estimateImageTokens(part.data);
		} else {
			tokens += approxTokenCount(JSON.stringify(part));
		}
	}
	// Mirrors the `withRetainedImages` guard in tool-result-images.ts:36, which skips restore when an image survived.
	if (!sawImage) {
		for (const image of retainedImagesFor(toolCallId)) {
			tokens += estimateImageTokens(image.data);
		}
	}
	return tokens;
}

function addCategory(categories: Map<string, number>, label: string, tokens: number): void {
	if (tokens <= 0) {
		return;
	}
	categories.set(label, (categories.get(label) ?? 0) + tokens);
}

function estimateToolCallTokens(part: Record<string, unknown>): number {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});
	return approxTokenCount(`${name}${input}`);
}

function addAssistantCategories(categories: Map<string, number>, content: unknown): void {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			addCategory(categories, "Assistant", approxTokenCount(part.text));
		} else if (part.type === "thinking" && typeof part.thinking === "string") {
			addCategory(categories, "Thinking", approxTokenCount(part.thinking));
		} else if (part.type === "toolCall") {
			addCategory(categories, "Assistant", estimateToolCallTokens(part));
		}
	}
}

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (const char of command) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char) || char === "|" || char === ";") {
			pushCurrent();
			continue;
		}
		current += char;
	}

	pushCurrent();
	return tokens;
}

function shellCommandName(command: string): string | undefined {
	const tokens = shellTokens(command.trim());
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token || token.includes("=")) {
			continue;
		}
		if (token === "command" || token === "builtin" || token === "noglob" || token === "time") {
			continue;
		}
		if (token === "sudo" || token === "env") {
			continue;
		}
		const name = token.replace(/\\/g, "/").split("/").pop();
		if (name === "bash" || name === "zsh" || name === "sh") {
			const script = tokens[index + 2];
			if ((tokens[index + 1] === "-c" || tokens[index + 1] === "-lc") && script) {
				return shellCommandName(script) ?? name;
			}
		}
		return name;
	}
	return undefined;
}

function toolCallCommands(messages: readonly unknown[]): Map<string, string> {
	const commands = new Map<string, string>();

	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") {
			continue;
		}
		for (const part of contentRecords(record.content)) {
			if (part.type !== "toolCall" || part.name !== "exec_command" || typeof part.id !== "string") {
				continue;
			}
			const args = part.arguments;
			if (args && typeof args === "object" && typeof (args as Record<string, unknown>).cmd === "string") {
				commands.set(part.id, (args as Record<string, string>).cmd);
			}
		}
	}

	return commands;
}

function commandFromToolResultContent(content: unknown): string | undefined {
	for (const part of contentRecords(content)) {
		if (part.type !== "text" || typeof part.text !== "string") {
			continue;
		}
		const match = part.text.match(/^Command:\s*(.+)$/m);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
}

function nestedReachWeights(
	record: Record<string, unknown>,
	resolveReach: (toolName: string) => ToolReach,
): Map<string, number> | undefined {
	const calls = (record.details as { calls?: unknown } | undefined)?.calls;
	if (!Array.isArray(calls)) return undefined;
	const weights = new Map<string, number>();
	for (const entry of calls) {
		const call = entry as { name?: unknown; resultTokens?: unknown } | undefined;
		if (typeof call?.name !== "string") continue;
		const tokens = typeof call.resultTokens === "number" && call.resultTokens > 0 ? call.resultTokens : 1;
		addCategory(weights, `Tool result: ${resolveReach(call.name)}`, tokens);
	}
	return weights.size > 0 ? weights : undefined;
}

function toolResultLabel(record: Record<string, unknown>, commandsByToolCallId: Map<string, string>): string {
	const toolName = record.toolName;
	const name = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "unknown";
	if (name === "exec_command") {
		const toolCallCommand =
			typeof record.toolCallId === "string" ? commandsByToolCallId.get(record.toolCallId) : undefined;
		const command = toolCallCommand ?? commandFromToolResultContent(record.content);
		const commandName = command ? shellCommandName(command) : undefined;
		if (commandName) {
			return `Tool result: exec_command(${commandName})`;
		}
	}
	return `Tool result: ${name}`;
}

// A turn's growth is exact, but with 6 tool results inside it the provider does not say which carried how much.
function categoryWeights(
	messages: readonly unknown[],
	commandsByToolCallId: Map<string, string>,
	resolveReach?: (toolName: string) => ToolReach,
): Map<string, number> {
	const categories = new Map<string, number>();

	for (const message of messages) {
		if (!message || typeof message !== "object") {
			continue;
		}
		const record = message as Record<string, unknown>;

		if (record.role === "user" || record.role === "custom") {
			addCategory(categories, "User prompts", estimateContentTokens(record.content));
		} else if (record.role === "assistant") {
			addAssistantCategories(categories, record.content);
		} else if (record.role === "toolResult") {
			const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
			const contentTokens = estimateContentTokens(record.content, toolCallId);
			const nested =
				resolveReach && (record.toolName === "exec" || record.toolName === "wait")
					? nestedReachWeights(record, resolveReach)
					: undefined;
			if (!nested) {
				addCategory(categories, toolResultLabel(record, commandsByToolCallId), contentTokens);
			} else {
				const labels = [...nested.keys()];
				const allocated = allocateProportionally([...nested.values()], contentTokens);
				for (const [index, label] of labels.entries()) addCategory(categories, label, allocated[index] ?? 0);
			}
		} else if (record.role === "bashExecution") {
			addCategory(categories, "User prompts", approxTokenCount(`${record.command ?? ""}${record.output ?? ""}`));
		} else if (record.role === "branchSummary" || record.role === "compactionSummary") {
			addCategory(categories, "Session summaries", approxTokenCount(String(record.summary ?? "")));
		}
	}

	return categories;
}

function allocateProportionally(values: readonly number[], total: number): number[] {
	if (total <= 0) {
		return values.map(() => 0);
	}

	const sourceTotal = values.reduce((sum, value) => sum + value, 0);
	if (sourceTotal <= 0) {
		return values.map(() => 0);
	}

	const raw = values.map((value) => (value / sourceTotal) * total);
	const allocated = raw.map(Math.floor);
	let remaining = total - allocated.reduce((sum, value) => sum + value, 0);
	const largestRemainders = raw
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remaining > 0; index++, remaining--) {
		const slot = largestRemainders[index];
		if (slot) {
			allocated[slot.index] = (allocated[slot.index] ?? 0) + 1;
		}
	}

	return allocated;
}

// Turn 1's prompt is the floor and cannot be split from usage alone; later turns split their own growth by weight.
// Compaction shrinks the prompt, so the accumulated split is dropped for the difference from the floor.
function attributeContext(
	messages: readonly unknown[],
	turns: readonly TurnUsage[],
	resolveReach?: (toolName: string) => ToolReach,
): SessionUsageCategory[] {
	const commandsByToolCallId = toolCallCommands(messages);
	const estimated = new Map<string, number>();
	let compactedTokens = 0;
	let previousMessageIndex: number | undefined;
	const floorTokens = turns.at(0)?.promptTokens ?? 0;

	for (const turn of turns) {
		if (previousMessageIndex === undefined) {
			previousMessageIndex = turn.messageIndex;
			continue;
		}

		if (turn.growth < 0) {
			estimated.clear();
			compactedTokens = Math.max(0, turn.promptTokens - floorTokens);
			previousMessageIndex = turn.messageIndex;
			continue;
		}

		const weights = categoryWeights(
			messages.slice(previousMessageIndex, turn.messageIndex),
			commandsByToolCallId,
			resolveReach,
		);
		const labels = [...weights.keys()];
		const allocated = allocateProportionally([...weights.values()], turn.growth);
		for (const [index, label] of labels.entries()) {
			const tokens = allocated[index] ?? 0;
			if (tokens > 0) estimated.set(label, (estimated.get(label) ?? 0) + tokens);
		}
		previousMessageIndex = turn.messageIndex;
	}

	const categories: SessionUsageCategory[] = [{ label: "Session floor", tokens: floorTokens, estimated: false }];
	if (compactedTokens > 0) {
		categories.push({ label: "Since compaction", tokens: compactedTokens, estimated: false });
	}
	for (const [label, tokens] of estimated) {
		categories.push({ label, tokens, estimated: true });
	}

	return categories.filter((category) => category.tokens > 0);
}

export function buildSessionUsageData(
	ctx: ExtensionCommandContext,
	resolveReach?: (toolName: string) => ToolReach,
): SessionUsageData | undefined {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & { getLeafId?: () => string | undefined };
	const context = buildSessionContext(ctx.sessionManager.getEntries(), sessionManager.getLeafId?.());
	const turns = readTurnUsage(context.messages);
	const totals = summarizeTurns(turns);

	if (!totals) {
		return undefined;
	}

	return {
		tokens: totals.contextTokens,
		totals,
		turns,
		categories: attributeContext(context.messages, turns, resolveReach),
	};
}

function systemPromptText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	if (Array.isArray(prompt)) {
		return prompt
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					const text = (part as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (prompt && typeof prompt === "object" && "content" in prompt) {
		return systemPromptText((prompt as { content?: unknown }).content);
	}
	return String(prompt ?? "");
}

const extension: ExtensionFactory = (pi) => {
	pi.registerCommand("token-burden", {
		description: "Show token budget breakdown and manage skills",
		handler: async (_args, ctx) => {
			const prompt = systemPromptText(ctx.getSystemPrompt());
			const parsed = parseSystemPrompt(prompt);

			// Imported here, not at the top: jiti's `moduleCache: false` would tax every pi boot with nested-dispatch.ts.
			const { buildCoreToolDeclarations, buildToolCatalog } = await import("../code-mode/nested-dispatch.ts");
			const sessionId = sessionIdFromContext(ctx);
			const policy = getToolPolicy(sessionId);
			const declarations = buildCoreToolDeclarations(undefined, sessionId, ctx.cwd);
			const resolveReach = toolReachResolver({
				activeToolNames: pi.getActiveTools(),
				catalogToolNames: buildToolCatalog(sessionId, ctx.cwd).map((entry) => entry.name),
				declaredToolNames: parseDeclaredToolNames(declarations),
				isHidden: policy?.isHidden,
			});

			const toolSection = buildToolDefinitionsSection(
				pi.getAllTools(),
				resolveReach,
				declarations ? approxTokenCount(declarations) : 0,
			);
			if (toolSection) {
				parsed.sections.push(toolSection);
				parsed.totalTokens += toolSection.tokens;
				parsed.totalChars += toolSection.chars;
			}

			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
			const sessionUsage = buildSessionUsageData(ctx, resolveReach);

			if (!ctx.hasUI) {
				return;
			}

			const agentDir = getAgentDir();
			const settingsPath = path.join(agentDir, "settings.json");
			const settings = loadSettings(settingsPath);
			const { skills, byName } = loadAllSkills(settings, undefined, agentDir);

			const onRunTrace = async (): Promise<BasePromptTraceResult> => {
				const sm = await SettingsManager.create(process.cwd(), agentDir);
				const configuredPaths = sm.getExtensionPaths();
				const { extensions, errors: loadErrors } = await discoverAndLoadExtensions(
					configuredPaths,
					process.cwd(),
					agentDir,
				);

				const contributions = extractContributions(extensions as unknown as LoadedExtension[]);

				const baseSection = parsed.sections.find((s) => s.label.startsWith("Base"));
				const baseText = baseSection?.content ?? "";
				const { toolLines, guidelineLines } = extractBaseLines(baseText);
				const baseTokens = approxTokenCount(baseText);

				const { buckets, evidence } = attributeBasePrompt(
					toolLines,
					guidelineLines,
					contributions,
					baseTokens,
					approxTokenCount,
				);

				const traceErrors = loadErrors.map((e) => ({
					source: e.path,
					message: e.error,
				}));

				return {
					fingerprint: extensions
						.map((e) => e.path)
						.toSorted()
						.join("|"),
					generatedAt: new Date().toISOString(),
					baseTokens,
					buckets,
					evidence,
					errors: traceErrors,
				};
			};

			const onToolReach = policy
				? (toolName: string, reach: ToolReach): boolean => policy.setToolReach(toolName, reach).applied
				: undefined;

			await showReport(
				parsed,
				contextWindow,
				ctx,
				skills,
				(result) => {
					if (!result.applied || result.changes.size === 0) {
						return true;
					}

					try {
						applyChanges(result.changes, byName, settingsPath, agentDir);

						const parts: string[] = [];
						const enabledCount = [...result.changes.values()].filter((v) => v === DisableMode.Enabled).length;
						const hiddenCount = [...result.changes.values()].filter((v) => v === DisableMode.Hidden).length;
						const disabledCount = [...result.changes.values()].filter((v) => v === DisableMode.Disabled).length;

						if (enabledCount > 0) {
							parts.push(`${enabledCount} enabled`);
						}
						if (hiddenCount > 0) {
							parts.push(`${hiddenCount} hidden`);
						}
						if (disabledCount > 0) {
							parts.push(`${disabledCount} disabled`);
						}

						ctx.ui.notify(
							`Skills updated: ${parts.join(", ")}. Use /reload or restart for changes to take effect.`,
							"info",
						);
						return true;
					} catch (error) {
						const msg = error instanceof Error ? error.message : "Unknown error";
						ctx.ui.notify(`Failed to save settings: ${msg}`, "error");
						return false;
					}
				},
				onRunTrace,
				onToolReach,
				sessionUsage,
			);
		},
	});
};

export default extension;
