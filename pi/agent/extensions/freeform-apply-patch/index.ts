import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "../../node_modules/@mariozechner/pi-ai/dist/index.js";
import { AssistantMessageEventStream } from "../../node_modules/@mariozechner/pi-ai/dist/utils/event-stream.js";
import {
	convertResponsesMessages,
	processResponsesStream,
} from "../../node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";

const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk | update_scope_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
update_scope_hunk: "*** Update Scope: " filename LF scope_change+

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
scope_change: "@@ " /(.+)/ LF change_line+ eof_line?
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);

export default function freeformApplyPatchProvider(pi: ExtensionAPI) {
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: streamFreeformCodexResponses,
	});
}

function streamFreeformCodexResponses(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const output = emptyAssistantMessage(model);
		try {
			const apiKey = options?.apiKey || "";
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			let body: any = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) body = nextBody;

			const response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: buildSSEHeaders(model.headers, options?.headers, extractAccountId(apiKey), apiKey, options?.sessionId),
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) throw new Error(await response.text());
			if (!response.body) throw new Error("No response body");

			stream.push({ type: "start", partial: output });
			await processResponsesStream(mapFreeformEvents(mapCodexEvents(parseSSE(response))), output, stream, model);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: output.stopReason as any, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).partialJson;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

function emptyAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function buildRequestBody(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const messages = convertFreeformResponsesMessages(model, context);
	const body: any = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: messages,
		text: { verbosity: (options as any)?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
	if (options?.temperature !== undefined) body.temperature = options.temperature;
	if (context.tools?.length) body.tools = convertTools(context.tools);
	if (options?.reasoning !== undefined) body.reasoning = { effort: options.reasoning === "minimal" ? "low" : options.reasoning, summary: "auto" };
	return body;
}

function convertFreeformResponsesMessages(model: Model<any>, context: Context) {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, { includeSystemPrompt: false });
	const applyPatchCallIds = new Set<string>();
	return messages.map((item: any) => {
		if (item?.type === "function_call" && item.name === "apply_patch") {
			applyPatchCallIds.add(item.call_id);
			let input = "";
			try {
				input = JSON.parse(item.arguments || "{}")?.input || "";
			} catch {}
			return {
				type: "custom_tool_call",
				id: item.id,
				call_id: item.call_id,
				name: item.name,
				input,
				status: "completed",
			};
		}
		if (item?.type === "function_call_output" && applyPatchCallIds.has(item.call_id)) {
			return {
				type: "custom_tool_call_output",
				call_id: item.call_id,
				output: item.output,
			};
		}
		return item;
	});
}

function convertTools(tools: Tool[]) {
	return tools.map((tool: any) => {
		if (tool.name !== "apply_patch") {
			return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: null };
		}
		return {
			type: "custom",
			name: "apply_patch",
			description: "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
			format: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_GRAMMAR },
		};
	});
}

async function* mapFreeformEvents(events: AsyncIterable<any>) {
	const customInputs = new Map<string, string>();
	const jsonStringOpen = new Set<string>();
	for await (const event of events) {
		if (event.type === "response.output_item.added" && event.item?.type === "custom_tool_call") {
			customInputs.set(event.item.id, event.item.input || "");
			yield { ...event, item: { ...event.item, type: "function_call", arguments: "" } };
			continue;
		}
		if (event.type === "response.custom_tool_call_input.delta") {
			const itemId = event.item_id || event.output_item_id;
			if (itemId) {
				const delta = event.delta || "";
				customInputs.set(itemId, `${customInputs.get(itemId) || ""}${delta}`);
				const prefix = jsonStringOpen.has(itemId) ? "" : "{\"input\":\"";
				jsonStringOpen.add(itemId);
				yield {
					type: "response.function_call_arguments.delta",
					delta: `${prefix}${escapeJsonStringFragment(delta)}`,
				};
			}
			continue;
		}
		if (event.type === "response.custom_tool_call_input.done") {
			const itemId = event.item_id || event.output_item_id;
			if (itemId) customInputs.set(itemId, event.input ?? customInputs.get(itemId) ?? "");
			if (itemId && jsonStringOpen.has(itemId)) {
				yield { type: "response.function_call_arguments.delta", delta: "\"}" };
				jsonStringOpen.delete(itemId);
			}
			continue;
		}
		if (event.type === "response.output_item.done" && event.item?.type === "custom_tool_call") {
			const raw = event.item.input ?? customInputs.get(event.item.id) ?? "";
			if (jsonStringOpen.has(event.item.id)) {
				yield { type: "response.function_call_arguments.delta", delta: "\"}" };
				jsonStringOpen.delete(event.item.id);
			}
			yield { type: "response.function_call_arguments.done", arguments: JSON.stringify({ input: raw }) };
			yield { ...event, item: { ...event.item, type: "function_call", arguments: JSON.stringify({ input: raw }) } };
			continue;
		}
		yield event;
	}
}

function escapeJsonStringFragment(value: string) {
	return JSON.stringify(value).slice(1, -1);
}

async function* mapCodexEvents(events: AsyncIterable<any>) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;
		if (type === "error") throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
		if (type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed");
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = event.response ? { ...event.response, status: normalizeCodexStatus(event.response.status) } : event.response;
			yield { ...event, type: "response.completed", response };
			return;
		}
		yield event;
	}
}

function normalizeCodexStatus(status: unknown) {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

async function* parseSSE(response: Response) {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
				if (data && data !== "[DONE]") {
					try { yield JSON.parse(data); } catch {}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try { await reader.cancel(); } catch {}
		try { reader.releaseLock(); } catch {}
	}
}

function resolveCodexUrl(baseUrl: string | undefined) {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractAccountId(token: string) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function buildSSEHeaders(initHeaders: Record<string, string> | undefined, additionalHeaders: Record<string, string> | undefined, accountId: string, token: string, sessionId: string | undefined) {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", "pi (freeform-apply-patch)");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => { out[key] = value; });
	return out;
}
