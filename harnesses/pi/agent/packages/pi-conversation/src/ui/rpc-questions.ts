import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionGroup } from "../core/state.ts";
import type { Conversation } from "../runtime/conversation.ts";

async function select(
	ctx: ExtensionContext,
	title: string,
	options: { value: string; label: string }[],
): Promise<string | undefined> {
	const label = await ctx.ui.select(
		title,
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === label)?.value;
}
export async function answerRpcQuestions(ctx: ExtensionContext, conversation: Conversation): Promise<void> {
	if (ctx.mode !== "rpc" || !ctx.hasUI) return;
	const groups = conversation.pending(ctx);
	if (!groups.length) {
		ctx.ui.notify("No pending questions", "info");
		return;
	}
	let group: QuestionGroup | undefined = groups[0];
	if (groups.length > 1) {
		const id = await select(
			ctx,
			"Pending questions",
			groups.map((group, index) => ({ value: group.id, label: `${index + 1}. ${group.questions[0].title}` })),
		);
		group = groups.find((group) => group.id === id);
	}
	if (!group) return;
	const answers: string[] = [];
	for (const question of group.questions) {
		let answer: string | undefined;
		if (question.options) {
			const choice = await select(ctx, question.title, [
				...question.options.map((label, index) => ({ value: String(index), label })),
				{ value: "free-text", label: "Write an answer…" },
			]);
			if (choice === undefined) return;
			answer = choice === "free-text" ? await ctx.ui.input(question.title) : question.options[Number(choice)];
		} else answer = await ctx.ui.input(question.title);
		if (!answer?.trim()) return;
		answers.push(answer);
	}
	conversation.answer(ctx, group, answers);
}
