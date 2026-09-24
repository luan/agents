import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ANSWER_ENTRY,
	answerMessage,
	isBackgroundAgent,
	pendingQuestions,
	QUESTION_ENTRY,
	RESPONSE_MESSAGE,
	type QuestionGroup,
	undeliveredAnswers,
} from "../src/core/state.ts";
import { waitForInput } from "../src/runtime/sleep.ts";

const question: QuestionGroup = {
	version: 1,
	id: "ask-1",
	questions: [{ title: "Which region?", options: ["Local", "Remote"] }],
};
test.each(["user", "custom"] as const)(
	"answers survive an undelivered queue and deduplicate %s delivery",
	(delivery) => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(QUESTION_ENTRY, question);
		expect(pendingQuestions(session.getBranch())).toEqual([question]);
		const answer = { version: 1 as const, id: question.id, answers: ["Local"], dismissed: false };
		session.appendCustomEntry(ANSWER_ENTRY, answer);
		expect(pendingQuestions(session.getBranch())).toEqual([]);
		expect(undeliveredAnswers(session.getBranch())).toEqual([answerMessage(question, answer)]);
		if (delivery === "user")
			session.appendMessage({ role: "user", content: answerMessage(question, answer), timestamp: 1 });
		else session.appendCustomMessageEntry(RESPONSE_MESSAGE, answerMessage(question, answer), false, answer);
		expect(undeliveredAnswers(session.getBranch())).toEqual([]);
	},
);
test("dismissal is explicit and does not infer approval", () => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry(QUESTION_ENTRY, question);
	session.appendCustomEntry(ANSWER_ENTRY, { version: 1, id: question.id, answers: [], dismissed: true });
	expect(undeliveredAnswers(session.getBranch())[0]).toContain("not approval");
	expect(pendingQuestions(session.getBranch())).toEqual([]);
});
test("pending questions follow branches", () => {
	const session = SessionManager.inMemory();
	const fork = session.appendCustomEntry("test/branch", {});
	session.appendCustomEntry(QUESTION_ENTRY, question);
	session.branch(fork);
	expect(pendingQuestions(session.getBranch())).toEqual([]);
});
test.each([false, true])("agent identity restricts all child interaction (interactive=%s)", (interactive) => {
	const session = SessionManager.inMemory();
	session.appendCustomEntry("session.identity/v1", {
		version: 1,
		rootSessionId: "root-id",
		agentName: "/root/child",
		interactive,
	});
	expect(isBackgroundAgent(session.getBranch())).toBe(true);
});
test("wait wakes on input and removes its timer callback", async () => {
	const waiters = new Set<() => void>();
	const result = waitForInput(43200000, waiters, false);
	for (const wake of waiters) wake();
	expect((await result).reason).toBe("input");
	expect(waiters.size).toBe(0);
});
test("pending input and cancellation never wait for wall clock time", async () => {
	const waiters = new Set<() => void>();
	expect((await waitForInput(43200000, waiters, true)).reason).toBe("input");
	const abort = new AbortController();
	const result = waitForInput(43200000, waiters, false, abort.signal);
	abort.abort();
	expect((await result).reason).toBe("cancelled");
	expect(waiters.size).toBe(0);
	expect(await waitForInput(43200000, waiters, false, abort.signal)).toEqual({ elapsed_ms: 0, reason: "cancelled" });
});
