import { requireModelTool } from "../contributions/model-tool-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANSWER_ENTRY,
	answerMessage,
	isBackgroundAgent,
	MESSAGE_ENTRY,
	pendingQuestions,
	QUESTION_ENTRY,
	RESPONSE_MESSAGE,
	type Question,
	type QuestionGroup,
} from "../core/state.ts";
import { type SleepResult, waitForInput } from "./sleep.ts";

export class Conversation {
	private readonly wakes = new Map<string, Set<() => void>>();
	private readonly listeners = new Set<(ctx: ExtensionContext) => void>();
	constructor(private readonly pi: ExtensionAPI) {}
	onChange(listener: (ctx: ExtensionContext) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private changed(ctx: ExtensionContext): void {
		for (const listener of this.listeners) listener(ctx);
	}
	pending(ctx: ExtensionContext): QuestionGroup[] {
		return pendingQuestions(ctx.sessionManager.getBranch());
	}
	question(ctx: ExtensionContext, id: string, questions: Question[]): void {
		requireModelTool(ctx.sessionManager.getSessionId(), "request_user_input_async");
		if (isBackgroundAgent(ctx.sessionManager.getBranch()))
			throw new Error("Ask your parent agent for clarification through its mailbox");
		if (
			questions.length === 0 ||
			questions.some((q) => !q.title.trim() || q.options?.length === 0 || q.options?.some((option) => !option.trim()))
		)
			throw new Error("Questions and options must not be empty");
		this.pi.appendEntry(QUESTION_ENTRY, { version: 1, id, questions });
		this.changed(ctx);
	}
	message(ctx: ExtensionContext, id: string, message: string): void {
		requireModelTool(ctx.sessionManager.getSessionId(), "send_message_to_user_async");
		if (isBackgroundAgent(ctx.sessionManager.getBranch()))
			throw new Error("Send updates to your parent agent through its mailbox");
		if (!message.trim()) throw new Error("Message must not be empty");
		this.pi.appendEntry(MESSAGE_ENTRY, { version: 1, id, message: message.trim() });
		this.changed(ctx);
	}
	answer(ctx: ExtensionContext, group: QuestionGroup, answers: string[], dismissed = false): void {
		if (!this.pending(ctx).some((pending) => pending.id === group.id))
			throw new Error("This question is no longer pending");
		if (!dismissed && (answers.length !== group.questions.length || answers.some((answer) => !answer.trim())))
			throw new Error("Answer every question before submitting");
		const answer = { version: 1 as const, id: group.id, answers, dismissed };
		this.pi.appendEntry(ANSWER_ENTRY, answer);
		// Keep the correlation envelope in model context; the answer entry owns its visible presentation.
		this.pi.sendMessage(
			{ customType: RESPONSE_MESSAGE, content: answerMessage(group, answer), details: answer, display: false },
			{ deliverAs: "steer", triggerTurn: true },
		);
		this.wake(ctx);
		this.changed(ctx);
	}
	wake(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();
		for (const wake of this.wakes.get(id) ?? []) wake();
		this.wakes.delete(id);
	}
	sleep(ctx: ExtensionContext, duration: number, signal?: AbortSignal): Promise<SleepResult> {
		requireModelTool(ctx.sessionManager.getSessionId(), "clock__sleep");
		const id = ctx.sessionManager.getSessionId(),
			waiters = this.wakes.get(id) ?? new Set<() => void>();
		this.wakes.set(id, waiters);
		return waitForInput(duration, waiters, ctx.hasPendingMessages(), signal);
	}
}
