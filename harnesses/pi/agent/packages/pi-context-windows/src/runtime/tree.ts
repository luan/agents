import { randomUUID } from "node:crypto";
import {
	prepareBranchEntries,
	type InputEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ARCHIVE_ENTRY } from "../core/archives.ts";
import { checkpoint, latestWindow, NOTE_ENTRY, ORIGIN_ENTRY, WINDOW_ENTRY, readNotes } from "../core/state.ts";
import { summarizeWindow } from "./summary.ts";
import type { ContextWindows } from "./windows.ts";
const CAPTURE = "pi-context-capture";
export class TreeArchives {
	private command?: ExtensionCommandContext;
	private pending?: {
		session: string;
		leaf: string;
		base: string;
		recovery: string;
		summary?: string;
		providerCheckpoint?: string;
		triggerTurn: boolean;
	};
	private navigating = false;
	private queued: InputEvent[] = [];
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly windows: ContextWindows,
	) {
		pi.registerCommand(CAPTURE, {
			handler: async (_args, ctx) => {
				this.command = ctx;
			},
		});
		pi.on("input", (event) => {
			if (!this.navigating || event.source === "extension") return;
			this.queued.push(structuredClone(event));
			return { action: "handled" };
		});
		pi.on("session_start", () => {
			pi.sendUserMessage(`/${CAPTURE}`, { expandPromptTemplates: true });
		});
		pi.on("session_before_tree", () =>
			this.navigating && this.pending
				? { summary: { summary: this.pending.summary ?? this.pending.recovery, details: { contextArchive: true } } }
				: undefined,
		);
		pi.on("session_before_switch", () => {
			if (this.navigating) return { cancel: true };
		});
		pi.on("session_shutdown", () => {
			this.command = undefined;
			this.pending = undefined;
		});
	}
	schedule(ctx: ExtensionContext, summary?: string, triggerTurn = true, providerCheckpoint?: string): void {
		const entries = ctx.sessionManager.getBranch();
		const base =
			latestWindow(entries)?.entryId ??
			entries.find((entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY)?.id;
		const leaf = ctx.sessionManager.getLeafId();
		if (!base || !leaf || this.command?.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId())
			throw new Error("Pi tree navigation is not ready; the outgoing window is intact");
		this.pending = {
			session: ctx.sessionManager.getSessionId(),
			leaf,
			base,
			recovery: checkpoint(entries),
			summary,
			triggerTurn,
			providerCheckpoint,
		};
		if (triggerTurn) ctx.abort();
	}
	async settle(ctx: ExtensionContext): Promise<void> {
		const pending = this.pending;
		if (!pending || !this.command || this.navigating) return;
		if (
			pending.session !== ctx.sessionManager.getSessionId() ||
			!ctx.sessionManager.getBranch().some((entry) => entry.id === pending.leaf)
		) {
			this.pending = undefined;
			return;
		}
		const from = ctx.sessionManager.getLeafId();
		const branch = ctx.sessionManager.getBranch();
		const notes = [...readNotes(branch).values()];
		// Custom records carry other extensions' durable state (questions, session settings, identities).
		// Their payloads stay opaque here and are validated by their owning extensions on restore.
		const carry = branch
			.slice(branch.findIndex((entry) => entry.id === pending.base) + 1)
			.filter(
				(entry) =>
					entry.type === "custom" &&
					![NOTE_ENTRY, WINDOW_ENTRY, ORIGIN_ENTRY, ARCHIVE_ENTRY].includes(entry.customType),
			);
		const draft = ctx.ui.getEditorText();
		this.navigating = true;
		try {
			const result = await this.command.navigateTree(pending.base, { summarize: true });
			if (ctx.sessionManager.getSessionId() !== pending.session)
				throw new Error("Session changed during context navigation");
			if (result.cancelled) throw new Error("Pi cancelled context archive navigation; the outgoing window is intact");
			this.pi.appendEntry(ARCHIVE_ENTRY, { version: 1, from, base: pending.base });
			for (const entry of carry) if (entry.type === "custom") this.pi.appendEntry(entry.customType, entry.data);
			for (const note of notes) this.pi.appendEntry(NOTE_ENTRY, { version: 1, path: note.path, text: note.text });
			this.windows.commit(ctx, pending.summary, pending.recovery, pending.providerCheckpoint);
			if (ctx.ui.getEditorText() === "") ctx.ui.setEditorText(draft);
			if (pending.triggerTurn && this.queued.length === 0)
				this.pi.sendMessage(
					{
						customType: "pi-context/continue",
						content:
							"Continue the current task from the new context window. Recover details from notes and history as needed.",
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.pending = undefined;
			this.navigating = false;
			// Re-admit complete inputs after navigation, including image attachments, exactly once.
			const queued = this.queued.splice(0);
			if (queued.length)
				this.pi.sendUserMessage(
					queued.flatMap((input) => [
						...(input.text ? [{ type: "text" as const, text: input.text }] : []),
						...(input.images ?? []),
					]),
					{ deliverAs: "followUp" },
				);
		}
	}
	get isNavigating(): boolean {
		return this.navigating;
	}
}

export function registerBranchHandoffs(pi: ExtensionAPI, tree: TreeArchives): void {
	let pending: { target: string; path: string; text: string } | undefined;
	pi.on("session_before_tree", async (event, ctx) => {
		pending = undefined;
		if (tree.isNavigating || !event.preparation.userWantsSummary) return;
		try {
			const { messages } = prepareBranchEntries(event.preparation.entriesToSummarize);
			const result = await summarizeWindow(
				ctx,
				messages,
				undefined,
				event.preparation.customInstructions,
				event.signal,
			);
			event.signal.throwIfAborted();
			const path = `handoff-${randomUUID()}.md`;
			pending = { target: event.preparation.targetId, path, text: result.text };
			return {
				summary: {
					summary: `Read the branch handoff note with notes__read_file({path: "${path}"}) before continuing.`,
					usage: result.usage,
					details: { notePath: path },
				},
			};
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { cancel: true };
		}
	});
	pi.on("session_tree", (event) => {
		const handoff = pending;
		pending = undefined;
		if (
			handoff &&
			event.summaryEntry?.details &&
			typeof event.summaryEntry.details === "object" &&
			"notePath" in event.summaryEntry.details &&
			event.summaryEntry.details.notePath === handoff.path
		)
			pi.appendEntry(NOTE_ENTRY, { version: 1, path: handoff.path, text: handoff.text });
	});
	pi.on("session_shutdown", () => {
		pending = undefined;
	});
}
