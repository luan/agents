/**
 * Answers a byte-identical repeat `read` with a pointer instead of the bytes.
 *
 * The wrap happens on the session's definition in the shared tool registry
 * rather than on a `tool_result` hook, because
 * a code-mode cell dispatches through the registry and skips `emitToolResult`
 * entirely (`code-mode/nested-dispatch.ts:1`). Wrapping `execute` is the only
 * seam both the Direct tool surface and a nested cell call pass through, so the
 * guard survives code-mode being toggled either way.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRegisteredTool } from "../shared/tool-registry.ts";
import { alreadyHandled, decide, forgetSession, ledgerForSession, type ReadDetails, readSignature } from "./ledger.ts";

const WRAPPED = Symbol.for("agents.readLedger.wrapped");

type ToolResult = { content?: unknown; details?: unknown; isError?: unknown };
type SessionContext = Pick<ExtensionContext, "sessionManager"> | undefined;

function sessionIdOf(ctx: SessionContext): string | undefined {
	const manager = ctx?.sessionManager as { getSessionId?: () => string } | undefined;
	const id = manager?.getSessionId?.();
	return typeof id === "string" && id ? id : undefined;
}

/**
 * Compactions seen so far, counted from the session branch rather than from the
 * `session_compact` event, so a provider-native compaction (the corpus records
 * `openai-native-compact-v2`) raises the generation the same as pi's own.
 * Without a branch there is no way to prove content survived, so the caller
 * treats `undefined` as "never point".
 */
function generationOf(ctx: SessionContext): number | undefined {
	const manager = ctx?.sessionManager as { getBranch?: () => unknown[] } | undefined;
	const branch = manager?.getBranch?.();
	if (!Array.isArray(branch)) return undefined;
	let seen = 0;
	for (const entry of branch) {
		if ((entry as { type?: unknown } | undefined)?.type === "compaction") seen++;
	}
	return seen;
}

function textOf(result: ToolResult): string {
	if (!Array.isArray(result.content)) return "";
	for (const block of result.content) {
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate?.type === "text" && typeof candidate.text === "string") return candidate.text;
	}
	return "";
}

/** The `[path#TAG]` header fileops writes at `fileops/index.ts:4406-4418`, reused so the pointer names what the model already holds. */
function headerOf(text: string, fallbackPath: string, tag: string): string {
	const header = text.match(/^\[[^\]\n]*\]/);
	return header ? header[0] : `[${fallbackPath}#${tag}]`;
}

const POINTER_MARK = "already read in this session and unchanged since.";
/** Stamped on a result seam 1 judged, so seam 2 skips it without relying on the two seams agreeing on a call id. */
const SEEN = "readLedgerSeen";

function stampSeen(result: ToolResult): ToolResult {
	const details = result.details;
	if (details && typeof details === "object") (details as Record<string, unknown>)[SEEN] = true;
	return result;
}

function wasSeen(details: unknown): boolean {
	return Boolean(details && typeof details === "object" && (details as Record<string, unknown>)[SEEN]);
}

/** Seam 2 must not re-judge a result seam 1 already replaced, whatever the call ids say. */
function isPointerText(text: string): boolean {
	return text.includes(POINTER_MARK);
}

function pointerResult(result: ToolResult, text: string, path: string, tag: string, tokens: number): ToolResult {
	const header = headerOf(text, path, tag);
	const body = `${header} ${POINTER_MARK} The ~${tokens.toLocaleString()} tokens of content are earlier in this conversation.`;
	const details = {
		...(result.details as Record<string, unknown> | undefined),
		outputTokens: Math.ceil(body.length / 4),
	};
	return { content: [{ type: "text", text: body }], details };
}

/**
 * The one decision point. Returns the replacement result, or undefined to leave
 * the read untouched.
 */
function judge(toolCallId: unknown, params: unknown, ctx: SessionContext, result: ToolResult): ToolResult | undefined {
	const signature = readSignature(params);
	const sessionId = sessionIdOf(ctx);
	const generation = generationOf(ctx);
	if (!signature || !sessionId || generation === undefined || !result) return undefined;

	const ledger = ledgerForSession(sessionId);
	if (typeof toolCallId === "string" && toolCallId && alreadyHandled(ledger, toolCallId)) return undefined;

	const details = (result.details ?? {}) as ReadDetails;
	const { pointer, entry } = decide(ledger, signature, details, generation, result.isError === true);
	if (!pointer) return undefined;
	return pointerResult(result, textOf(result), String(signature.split("|")[0]), entry.tag, entry.tokens);
}

export default function readLedgerExtension(pi: ExtensionAPI): void {
	// Seam 1 — a code-mode cell calls the registry definition directly and never
	// reaches `tool_result`, so the guard has to sit on `execute` itself.
	const install = (ctx?: SessionContext) => {
		const tool = getRegisteredTool("read", sessionIdOf(ctx)) as
			| (Record<symbol | string, unknown> & { execute?: unknown })
			| undefined;
		if (!tool || typeof tool.execute !== "function" || tool[WRAPPED]) return;
		const original = tool.execute as (...args: unknown[]) => Promise<ToolResult>;
		tool.execute = async (...args: unknown[]): Promise<ToolResult> => {
			const result = await original(...args);
			return stampSeen(judge(args[0], args[1], args[4] as SessionContext, result) ?? result);
		};
		tool[WRAPPED] = true;
	};

	// Extension load order is not guaranteed, so the wrap waits until fileops has registered `read`.
	pi.on("session_start", (_event, ctx) => {
		install(ctx);
	});

	// Seam 2 — the Direct tool surface. `wrapper.js:14` captures `execute` when the
	// registry refreshes, so a Direct call can still run the pre-wrap function;
	// this hook catches it. `alreadyHandled` keeps a call that hits both seams
	// from counting as its own repeat.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		if (wasSeen(event.details)) return;
		const incoming = { content: event.content, details: event.details, isError: event.isError };
		if (isPointerText(textOf(incoming))) return;
		const replacement = judge(event.toolCallId, event.input, ctx as SessionContext, incoming);
		if (!replacement) return;
		return { content: replacement.content as never, details: replacement.details };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = sessionIdOf(ctx as SessionContext);
		if (sessionId) forgetSession(sessionId);
	});
}
