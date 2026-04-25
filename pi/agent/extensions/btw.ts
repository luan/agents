import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const ENTRY_TYPE = "btw-history";
const WIDGET_ID = "btw";
const MAX_TRANSCRIPT_CHARS = 14_000;
const MAX_TOOL_RESULT_CHARS = 800;
const COMPLETED_TTL_MS = 90_000;

type SessionEntryLike = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
};

type BtwItem = {
	id: number;
	question: string;
	state: "loading" | "answer" | "error";
	answer?: string;
	error?: string;
	model: string;
	expiresAt?: number;
};

type Runtime = {
	items: BtwItem[];
	timer?: ReturnType<typeof setTimeout>;
};

const runtimes = new Map<string, Runtime>();
const pending = new Map<string, unknown[]>();
let nextId = 1;

const SYSTEM_PROMPT = [
	"You are answering a quick side question while the user's main pi session continues working.",
	"Use the provided transcript only as background context.",
	"Answer directly and concisely.",
	"If the transcript is insufficient, say that briefly instead of guessing.",
].join("\n");

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function runtime(ctx: ExtensionContext): Runtime {
	const key = sessionKey(ctx);
	const existing = runtimes.get(key);
	if (existing) return existing;
	const next: Runtime = { items: [] };
	runtimes.set(key, next);
	return next;
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return undefined;
			const block = part as { type?: string; text?: string; name?: string; arguments?: unknown };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "toolCall" && typeof block.name === "string") return `Assistant called ${block.name}(${JSON.stringify(block.arguments ?? {})})`;
			return undefined;
		})
		.filter((part): part is string => !!part);
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function transcript(entries: SessionEntryLike[]): string {
	const sections: string[] = [];
	for (const entry of entries.filter((e) => e.type === "message").slice(-20)) {
		const message = entry.message;
		if (!message?.role) continue;
		const text = textParts(message.content).join("\n").trim();
		if (!text) continue;
		if (message.role === "toolResult") {
			sections.push(`Tool result from ${message.toolName ?? "tool"}: ${clip(text, MAX_TOOL_RESULT_CHARS)}`);
		} else {
			sections.push(`${message.role}: ${message.role === "assistant" ? clip(text, MAX_TOOL_RESULT_CHARS * 2) : text}`);
		}
	}
	const joined = sections.join("\n\n");
	return joined.length <= MAX_TRANSCRIPT_CHARS ? joined : `...[earlier context omitted]\n\n${joined.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

function modelLabel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown-model";
}

function render(ctx: ExtensionContext, rt: Runtime) {
	if (!ctx.hasUI) return;
	const live = rt.items.filter((item) => item.state === "loading" || !item.expiresAt || item.expiresAt > Date.now()).slice(-2);
	rt.items = live;
	if (live.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	const lines: string[] = [];
	for (const item of live) {
		lines.push(`btw: ${item.question}`);
		if (item.state === "loading") lines.push(`  asking ${item.model}…`);
		if (item.state === "answer") lines.push(...(item.answer ?? "").split("\n").slice(0, 8).map((line) => `  ${line}`));
		if (item.state === "error") lines.push(`  error: ${item.error}`);
	}
	ctx.ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, record: unknown) {
	if (ctx.isIdle()) {
		pi.appendEntry(ENTRY_TYPE, record);
		return;
	}
	const key = sessionKey(ctx);
	pending.set(key, [...(pending.get(key) ?? []), record]);
}

function flush(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.isIdle()) return;
	const key = sessionKey(ctx);
	const records = pending.get(key) ?? [];
	for (const record of records) pi.appendEntry(ENTRY_TYPE, record);
	pending.delete(key);
}

async function answer(question: string, ctx: ExtensionContext): Promise<string> {
	if (!ctx.model) throw new Error("No model selected.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (auth.ok === false) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key available for ${modelLabel(ctx)}.`);
	const userMessage: UserMessage = {
		role: "user",
		timestamp: Date.now(),
		content: [{ type: "text", text: `Current transcript:\n<session>\n${transcript(ctx.sessionManager.getBranch() as SessionEntryLike[])}\n</session>\n\nSide question:\n${question}` }],
	};
	const response = await complete(ctx.model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal });
	if (response.stopReason === "aborted") throw new Error("Cancelled.");
	return response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim() || "No response received.";
}

function start(question: string, pi: ExtensionAPI, ctx: ExtensionContext) {
	const rt = runtime(ctx);
	const item: BtwItem = { id: nextId++, question, state: "loading", model: modelLabel(ctx) };
	rt.items.push(item);
	render(ctx, rt);

	void answer(question, ctx)
		.then((result) => {
			item.state = "answer";
			item.answer = result;
			item.expiresAt = Date.now() + COMPLETED_TTL_MS;
			persist(pi, ctx, { question, answer: result, model: item.model, answeredAt: new Date().toISOString() });
		})
		.catch((error) => {
			item.state = "error";
			item.error = error instanceof Error ? error.message : String(error);
			item.expiresAt = Date.now() + COMPLETED_TTL_MS;
			persist(pi, ctx, { question, error: item.error, model: item.model, answeredAt: new Date().toISOString() });
		})
		.finally(() => {
			render(ctx, rt);
			if (rt.timer) clearTimeout(rt.timer);
			rt.timer = setTimeout(() => render(ctx, rt), COMPLETED_TTL_MS + 250);
		});
}

export default function btwExtension(pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		const match = event.text.match(/^\/btw(?:\s+([\s\S]*))?$/);
		if (!match) return { action: "continue" as const };
		if (!ctx.hasUI) return { action: "continue" as const };
		const question = (match[1] ?? "").trim();
		if (!question) {
			ctx.ui.notify("Usage: /btw <question>", "warning");
			return { action: "handled" as const };
		}
		start(question, pi, ctx);
		return { action: "handled" as const };
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Ask the current editor text as a side question",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const question = ctx.ui.getEditorText().trim();
			if (!question) return ctx.ui.notify("Type a side question first, then press Ctrl+Shift+B.", "warning");
			ctx.ui.setEditorText("");
			start(question, pi, ctx);
		},
	});

	pi.on("agent_end", (_event, ctx) => flush(pi, ctx));
	pi.on("session_start", (_event, ctx) => render(ctx, runtime(ctx)));
	pi.on("session_shutdown", () => {
		for (const rt of runtimes.values()) if (rt.timer) clearTimeout(rt.timer);
		runtimes.clear();
		pending.clear();
	});
}
