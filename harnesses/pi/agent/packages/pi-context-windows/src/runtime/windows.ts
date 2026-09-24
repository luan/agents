import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { checkpoint, initialWindowId, latestWindow, messageKey, ORIGIN_ENTRY, WINDOW_ENTRY } from "../core/state.ts";
import type { ContextWindowProvider } from "../protocol/context-window.ts";

export class ContextWindows implements ContextWindowProvider {
	private readonly contexts = new Map<string, ExtensionContext>();
	private readonly pending = new Set<string>();
	constructor(private readonly pi: ExtensionAPI) {}
	bind(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();
		for (const previous of this.contexts.keys())
			if (previous !== id) {
				this.contexts.delete(previous);
				this.pending.delete(previous);
			}
		this.contexts.set(id, ctx);
		const entries = ctx.sessionManager.getBranch();
		if (!entries.some((entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY))
			this.pi.appendEntry(ORIGIN_ENTRY, { version: 1, id: initialWindowId(ctx.sessionManager.getSessionId()) });
	}
	forget(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();
		this.contexts.delete(id);
		this.pending.delete(id);
	}
	entries(id: string): SessionEntry[] | undefined {
		return this.contexts.get(id)?.sessionManager.getBranch();
	}
	snapshot(id: string) {
		const entries = this.entries(id);
		if (!entries) return;
		const window = latestWindow(entries);
		if (!window) return;
		return {
			id: window.state.id,
			boundaryEntryId: window.entryId,
			checkpoint: window.state.checkpoint,
			providerCheckpoint: window.state.providerCheckpoint,
		};
	}
	request(ctx: ExtensionContext): void {
		this.bind(ctx);
		this.pending.add(ctx.sessionManager.getSessionId());
	}
	isPending(ctx: ExtensionContext): boolean {
		return this.pending.has(ctx.sessionManager.getSessionId());
	}
	commit(ctx: ExtensionContext, summary?: string, recovery?: string, providerCheckpoint?: string): boolean {
		const id = ctx.sessionManager.getSessionId();
		if (!this.pending.delete(id)) return false;
		const entries = ctx.sessionManager.getBranch();
		this.pi.appendEntry(WINDOW_ENTRY, {
			version: 1,
			id: randomUUID(),
			previous: latestWindow(entries)?.state.id ?? initialWindowId(id, entries),
			checkpoint: summary
				? `${recovery ?? checkpoint(entries)}\n\nConversation summary:\n${summary}`
				: (recovery ?? checkpoint(entries)),
			...(summary ? { summary } : {}),
			...(providerCheckpoint ? { providerCheckpoint } : {}),
		});
		return true;
	}
	project(id: string, messages: AgentMessage[]): AgentMessage[] {
		const entries = this.entries(id);
		if (!entries) return messages;
		const window = latestWindow(entries);
		const allMessages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const ids = new Map(
			entries.flatMap((entry) => (entry.type === "message" ? [[messageKey(entry.message), entry.id] as const] : [])),
		);
		const known = new Set(allMessages.map(messageKey));
		const activeEntries = window ? entries.slice(window.index + 1) : entries;
		const active = new Set(
			activeEntries.flatMap((entry) => (entry.type === "message" ? [messageKey(entry.message)] : [])),
		);
		const tail = messages
			.filter((message) => {
				if (!window) return true;
				if (message.role === "compactionSummary" || message.role === "branchSummary") return false;
				if (message.role === "custom") {
					const entry = entries.find(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === message.customType &&
							Date.parse(entry.timestamp) === message.timestamp,
					);
					return !entry || activeEntries.includes(entry);
				}
				return !known.has(messageKey(message)) || active.has(messageKey(message));
			})
			.map((message) => {
				const itemId = ids.get(messageKey(message));
				// Tool outputs may have a schema; history tools expose their IDs without altering their content.
				if (!itemId || message.role !== "user") return message;
				const suffix = { type: "text" as const, text: `[id: ${itemId}]` };
				return {
					...message,
					content:
						typeof message.content === "string" ? `${message.content}\n${suffix.text}` : [...message.content, suffix],
				};
			});
		const windowId = window?.state.id ?? initialWindowId(id, entries);
		const ctx = this.contexts.get(id),
			remaining = ctx ? this.remaining(ctx) : null;
		const reminder =
			remaining !== null && remaining < 16384
				? `\nOnly ${remaining} tokens remain. Save your checkpoint and call new_context before starting more work.`
				: "";
		const prefix = `<context_window>\nCurrent window: ${windowId}${window ? `\nPrevious window: ${window.state.previous}\nRecovery checkpoint:\n${window.state.checkpoint}` : ""}\nUse history and notes to recover details outside this window.${reminder}\n</context_window>`;
		return [
			{ role: "custom", customType: "pi-context/window-context", content: prefix, display: false, timestamp: 0 },
			...tail,
		];
	}
	remaining(ctx: ExtensionContext): number | null {
		const entries = ctx.sessionManager.getBranch();
		const window = latestWindow(entries);
		const tail = window ? entries.slice(window.index + 1) : entries;
		const last = [...tail]
			.reverse()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason !== "error" &&
					entry.message.stopReason !== "aborted",
			);
		if (window && !last) return null;
		const usage = ctx.getContextUsage();
		return usage?.tokens === null || usage?.tokens === undefined
			? null
			: Math.max(0, usage.contextWindow - usage.tokens);
	}
	compaction(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getBranch();
		const window = latestWindow(entries);
		if (!window) return;
		const first = entries
			.slice(window.index + 1)
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		const firstKeptEntryId = first?.id ?? window.entryId;
		return {
			summary: window.state.checkpoint,
			firstKeptEntryId,
			tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
			details: { version: 1, contextWindowId: window.state.id },
		};
	}
	currentMessages(ctx: ExtensionContext): AgentMessage[] {
		return this.project(
			ctx.sessionManager.getSessionId(),
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
	}
}
