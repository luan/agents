/**
 * code-mode: the model writes a program, the program calls the tools.
 *
 * Only `exec`, `wait` and `ask_user` stay active. Every other registered tool is called from inside a cell as
 * `tools.*`. 25 active tools measured 8,082 resident schema tokens before any call, and over 861 sessions tool
 * results cost ~8.57 billion resident tokens. `ask_user` stays direct because it blocks on a human inside the
 * turn, which a cell cannot do. `exec` and `wait` stay direct because a cell runner cannot host itself.
 */

import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getCurrentArtifactSessionId } from "../artifact-store/pi/current-session.ts";
import { approxTokenCount } from "../shared/output-budget.ts";
import { boundTextWithArtifact, HARD_MAX_TOOL_TOKENS, resolveToolBudget } from "../shared/tool-bounding.ts";
import { toolRegistrarFor } from "../shared/tool-registry.ts";
import { registerToolResultImageRestore } from "../shared/tool-result-images.ts";
import { markLiveTurnStarted } from "../shared/tui/index.ts";
import { buildToolCatalog, callNestedTool, sessionIdOf } from "./nested-dispatch.ts";
import { registerCodeModePreflightBroker } from "./nested-tool-preflight.ts";
import {
	type CellParams,
	EXEC_DESCRIPTION,
	EXEC_GRAMMAR,
	nothingToRunReason,
	prepareCellArguments,
} from "./payload.ts";
import { cellToolPresentation } from "./presentation.ts";
import { type CellRenderDetails, isSerializedNestedResult } from "./render.ts";
import {
	CELL_YIELD_GRACE_MS,
	type CellLanguage,
	type CellRecord,
	CellSessionRegistry,
	type CollectResult,
	collect,
	countEchoed,
	echoedLines,
	nestedCallFailureText,
} from "./runtime.ts";
import type { HostBridge } from "./rust-kernel.ts";
import { tomlYieldTimeForSource } from "./toml-tools.ts";

const DEFAULT_YIELD_TIME_MS = 30_000;
const MAX_YIELD_TIME_MS = 120_000;
const MAX_OUTPUT_TOKENS_CEILING = HARD_MAX_TOOL_TOKENS;

// `write_stdin`'s floor and ceiling are also 30_000 and 120_000 (exec-session-manager.ts:196,197), so a nested wait
// ended as the cell gave up: "Cell 60 is still running after 30001ms". Added after the clamp, so the declarable
// ceiling stays 120_000 and the window still exceeds it.

function clampYield(value: unknown): number {
	const requested = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_YIELD_TIME_MS;
	return Math.min(MAX_YIELD_TIME_MS, Math.max(1, Math.floor(requested)));
}

export function cellWindowMs(value: unknown): number {
	return clampYield(value) + CELL_YIELD_GRACE_MS;
}

function requestedTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clampNotices(yieldMs: unknown, maxTokens: unknown): string[] {
	const notices: string[] = [];
	const requestedYield = requestedTokens(yieldMs);
	if (requestedYield !== undefined && requestedYield > MAX_YIELD_TIME_MS) {
		notices.push(`yield-time_ms requested ${requestedYield}; clamped to ${MAX_YIELD_TIME_MS}.`);
	}
	const requestedMaxTokens = requestedTokens(maxTokens);
	if (requestedMaxTokens !== undefined && requestedMaxTokens > MAX_OUTPUT_TOKENS_CEILING) {
		notices.push(`max_output_tokens requested ${requestedMaxTokens}; clamped to ${MAX_OUTPUT_TOKENS_CEILING}.`);
	}
	return notices;
}

type CellUpdate = AgentToolUpdateCallback<CellRenderDetails>;

type CellResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// `onUpdate` emits `tool_execution_update`, not `tool_result`, so `tool-policy`'s central bound never sees it and
// nothing here is counted or clipped twice.
async function withCellActivity<T>(record: CellRecord, onUpdate: CellUpdate | undefined, run: () => Promise<T>) {
	if (!onUpdate) return await run();
	const publish = () =>
		onUpdate({
			content: [],
			details: {
				cell_id: record.id,
				language: record.language,
				code: record.code,
				status: "running",
				calls: record.calls,
			},
		});
	record.onActivity = publish;
	publish();
	try {
		return await run();
	} finally {
		record.onActivity = undefined;
	}
}

async function formatCell(
	collected: CollectResult,
	maxTokens: number | undefined,
	toolName: "exec" | "wait",
	notices: readonly string[] = [],
	sessionId?: string,
): Promise<{ content: CellResultContent[]; details: CellRenderDetails; isError: boolean }> {
	const { record, outcome, error, done, durationMs } = collected;
	const raw = !done
		? `Cell ${record.id} is still running after ${Math.round(durationMs)}ms. Collect it with wait(cell_id: ${record.id}).`
		: error
			? error.message
			: [outcome?.output ?? "", outcome?.error ?? ""].filter(Boolean).join("\n");
	const failureText = done ? (error?.message ?? outcome?.error) : undefined;
	const errorCallId = failureText
		? record.calls.findLast((call) => nestedCallFailureText(call) === failureText)?.toolCallId
		: undefined;
	const bounded = await boundTextWithArtifact(raw, {
		maxTokens: resolveToolBudget(toolName, maxTokens),
		label: `${toolName} cell ${record.id}`,
		ownerSessionId: sessionId,
	});
	const serializedNestedResult = isSerializedNestedResult(raw, record.calls);
	const recoveryNotice = bounded.text
		.split("\n")
		.find((line) => /^\[(?:…|output bounded\b).*(?:Full output:|Not recoverable\b).*\]$/.test(line));
	const serializedNestedResultNotice = serializedNestedResult
		? [...notices, ...(recoveryNotice ? [recoveryNotice] : [])].join("\n") || undefined
		: undefined;
	// A cell whose answer is that a command finished has status and wall time and nothing else. Codex prefixes this
	// header to every cell result; here it lands only where the cell printed nothing, so an answering cell pays zero.
	const body = bounded.text || `Cell ${record.id} completed. Wall time ${(durationMs / 1000).toFixed(1)} seconds.`;
	// `echoNotice` in runtime.ts is built and tested but not wired: it ships only once a probe shows it cuts dumping.
	const text = [...notices, body].join("\n");
	return {
		content: [
			{ type: "text", text },
			...(outcome?.images ?? []).map((image) => ({
				type: "image" as const,
				data: image.data,
				mimeType: image.mimeType,
			})),
		],
		details: {
			cell_id: record.id,
			language: record.language,
			code: record.code,
			status: !done ? "running" : error || outcome?.error ? "error" : "completed",
			durationMs,
			artifactUri: bounded.artifactUri,
			outputTokens: approxTokenCount(text),
			errorCallId,
			serializedNestedResult: serializedNestedResult || undefined,
			serializedNestedResultNotice,
			calls: record.calls,
			sessionId,
			// Measured here: `liveResults` is a WeakMap on record identity, so a resumed row saw 1 preview line per call.
			copiedLines: countEchoed(text, echoedLines(record.calls)).copied,
		},
		isError: done && Boolean(error || outcome?.error),
	};
}

export default function codeModeExtension(pi: ExtensionAPI): void {
	const registry = new CellSessionRegistry();
	const preflight = registerCodeModePreflightBroker(pi);

	pi.on("session_shutdown", () => registry.reset());
	pi.on("session_tree", () => registry.reset());

	// The cell card strips emitted images from the result so the TUI does not draw them twice; this restores them.
	registerToolResultImageRestore(pi);

	// pi's agent loop takes `isError` from a throw and ignores the field on a returned result, so a failed cell was
	// recorded as a success. Throwing instead makes pi replace the result wholesale, and the cell loses the `details`
	// its card is drawn from.
	pi.on("tool_result", (event) => {
		if (event.toolName !== "exec" && event.toolName !== "wait") return undefined;
		const status = (event.details as CellRenderDetails | undefined)?.status;
		return status === "error" && !event.isError ? { isError: true } : undefined;
	});

	// Replayed history carries the same render flags a live call has, so a resumed session spun a spinner on each cell.
	pi.on?.("turn_start", () => markLiveTurnStarted());
	// Bind each cell session to its own context. A shared mutable context lets a concurrent subagent overwrite the
	// session id while another cell is waiting, so its nested read and edit use different snapshot stores.
	const bridgeForContext = (ctx: ExtensionContext): HostBridge => ({
		callTool: (call) =>
			callNestedTool(call.name, call.args, {
				ctx,
				signal: call.signal,
				maxTokens: call.maxTokens,
				toolCallId: call.toolCallId,
				preflight: preflight.run,
			}),
		// Use pi.sendMessage, not onUpdate: an onUpdate partial reaches only the TUI. The conversion to a plain user
		// message drops customType, so the cell is named in the text or the line reads as the user's own. Use pi rather
		// than ctx because a cell can outlive the turn that created its context.
		notify: (text, cellId) => {
			pi.sendMessage({
				customType: "code_mode_notify",
				content: cellId === undefined ? text : `[cell ${cellId}] ${text}`,
				display: true,
			});
		},
	});

	const sessionFor = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? getCurrentArtifactSessionId() ?? "default";
		return registry.session(sessionId, () => bridgeForContext(ctx));
	};

	const registerCellTool = toolRegistrarFor(pi);

	registerCellTool({
		name: "exec",
		label: "exec",
		description: EXEC_DESCRIPTION,
		promptSnippet: "Run a code cell; call every other tool from inside it as tools.<name>(args).",
		promptGuidelines: [
			"Use exec for every tool call. `tools.<name>(args)` inside a cell reaches the same tool at the same cost, and only what the cell prints enters the context window.",
			"Print the answer, not the evidence. A cell that returns a whole file has saved nothing.",
		],
		executionMode: "sequential",
		...cellToolPresentation,
		// `code` must stay the schema's only required property; pi refuses the tool when there is not exactly one.
		constrainedSampling: { type: "grammar", variants: { openai_lark: EXEC_GRAMMAR } },
		prepareArguments: prepareCellArguments,
		parameters: Type.Object(
			{
				code: Type.String({ description: "Cell body. Raw source, never fenced." }),
				language: Type.Optional(
					Type.Union([Type.Literal("ts"), Type.Literal("js")], {
						description: "Source syntax label for the cell.",
					}),
				),
				yield_time_ms: Type.Optional(
					Type.Number({
						description: `How long to wait before yielding. Defaults to ${DEFAULT_YIELD_TIME_MS}, capped at ${MAX_YIELD_TIME_MS}. A still-running cell keeps its cell_id.`,
					}),
				),
				max_output_tokens: Type.Optional(
					Type.Number({
						minimum: 1,
						description: `Ceiling on returned output tokens. Values above ${MAX_OUTPUT_TOKENS_CEILING} are clamped with a result notice.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(
			_toolCallId: string,
			rawParams: CellParams,
			signal: AbortSignal | undefined,
			onUpdate: CellUpdate | undefined,
			ctx: ExtensionContext,
		) {
			const nothingToRun = nothingToRunReason(rawParams);
			if (nothingToRun) throw new Error(nothingToRun);
			const session = sessionFor(ctx);
			const language: CellLanguage = rawParams.language ?? "ts";
			const yieldTimeMs = clampYield(tomlYieldTimeForSource(rawParams.code, ctx.cwd) ?? rawParams.yield_time_ms);
			const record = session.start({
				code: rawParams.code,
				language,
				yieldTimeMs,
				catalog: buildToolCatalog(sessionIdOf(ctx), ctx.cwd),
				signal,
			});
			const collected = await withCellActivity(record, onUpdate, () =>
				collect(record, yieldTimeMs + CELL_YIELD_GRACE_MS),
			);
			return await formatCell(
				collected,
				requestedTokens(rawParams.max_output_tokens),
				"exec",
				clampNotices(rawParams.yield_time_ms, rawParams.max_output_tokens),
				sessionIdOf(ctx),
			);
		},
	});

	registerCellTool({
		name: "wait",
		label: "wait",
		description:
			"Collect a cell that outlived its yield window. Returns the same result exec would have, or reports the cell still running so you can wait again.",
		promptSnippet: "Collect a running cell by cell_id.",
		executionMode: "sequential",
		...cellToolPresentation,
		parameters: Type.Object(
			{
				cell_id: Type.Number({ description: "The cell_id exec returned." }),
				yield_time_ms: Type.Optional(
					Type.Number({
						description: `How long to wait before yielding again. Defaults to ${DEFAULT_YIELD_TIME_MS}, capped at ${MAX_YIELD_TIME_MS}.`,
					}),
				),
				max_output_tokens: Type.Optional(
					Type.Number({
						minimum: 1,
						description: `Ceiling on returned output tokens. Values above ${MAX_OUTPUT_TOKENS_CEILING} are clamped with a result notice.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(
			_toolCallId: string,
			rawParams: { cell_id: number; yield_time_ms?: number; max_output_tokens?: number },
			_signal: AbortSignal | undefined,
			onUpdate: CellUpdate | undefined,
			ctx: ExtensionContext,
		) {
			const session = sessionFor(ctx);
			const record: CellRecord | undefined = session.cell(rawParams.cell_id);
			if (!record) {
				return {
					content: [{ type: "text" as const, text: `No cell ${rawParams.cell_id} in this session.` }],
					details: { cell_id: rawParams.cell_id, status: "error" },
					isError: true,
				};
			}
			const collected = await withCellActivity(record, onUpdate, () =>
				collect(record, cellWindowMs(rawParams.yield_time_ms)),
			);
			return await formatCell(
				collected,
				requestedTokens(rawParams.max_output_tokens),
				"wait",
				clampNotices(rawParams.yield_time_ms, rawParams.max_output_tokens),
				sessionIdOf(ctx),
			);
		},
	});
}
