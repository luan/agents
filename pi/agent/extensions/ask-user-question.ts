import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const QuestionKind = StringEnum(["radio", "checkbox", "text", "confirm"] as const);

const OptionSchema = Type.Object({
	label: Type.String({ description: "Human-readable option label" }),
	value: Type.Optional(Type.String({ description: "Machine-readable value. Defaults to label." })),
	description: Type.Optional(Type.String({ description: "Extra context shown in the option label when possible" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable answer key" }),
	type: QuestionKind,
	question: Type.String(),
	description: Type.Optional(Type.String()),
	options: Type.Optional(Type.Array(OptionSchema)),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-form answer for radio/checkbox questions" })),
	default: Type.Optional(Type.String()),
});

const AskUserQuestionSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Dialog title" })),
	description: Type.Optional(Type.String({ description: "Context shown before the questions" })),
	questions: Type.Array(QuestionSchema, { description: "Questions to ask sequentially" }),
});

type Option = {
	label: string;
	value?: string;
	description?: string;
};

type Question = {
	id: string;
	type: "radio" | "checkbox" | "text" | "confirm";
	question: string;
	description?: string;
	options?: Option[];
	allowOther?: boolean;
	default?: string;
};

type Answer = string | string[] | boolean | null;

function optionText(option: Option): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

function optionValue(option: Option): string {
	return option.value ?? option.label;
}

function promptText(title: string | undefined, question: Question): string {
	return [title, question.question, question.description].filter(Boolean).join("\n");
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description:
			"Ask the user structured questions with radio, checkbox, text, or confirm controls. Prefer this over plain-text questions when user input is needed to continue.",
		promptSnippet: "Ask the user structured questions and return typed answers",
		promptGuidelines: [
			"Use ask_user_question instead of free-form prose when you need a user decision, preference, or missing requirement.",
			"Group related questions into one ask_user_question call.",
			"Use radio for one choice, checkbox for multiple choices, confirm for yes/no, and text for open-ended input.",
		],
		parameters: AskUserQuestionSchema as any,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as { title?: string; description?: string; questions?: Question[] };
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "Cannot ask user questions: UI is not available." }],
					details: { cancelled: true, answers: {} },
				};
			}

			const questions = (params.questions ?? []) as Question[];
			if (questions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No questions were provided." }],
					details: { cancelled: true, answers: {} },
				};
			}

			if (params.description) ctx.ui.notify(params.description, "info");

			const answers: Record<string, Answer> = {};
			for (const question of questions) {
				const title = params.title ?? "Input needed";
				const message = promptText(title, question);
				if (question.type === "text") {
					const answer = await ctx.ui.editor(message, question.default ?? "");
					if (answer === undefined) return cancelled(answers);
					answers[question.id] = answer.trim();
					continue;
				}

				if (question.type === "confirm") {
					answers[question.id] = await ctx.ui.confirm(title, [question.question, question.description].filter(Boolean).join("\n"));
					continue;
				}

				const options = question.options ?? [];
				if (options.length === 0) {
					return {
						content: [{ type: "text" as const, text: `Question ${question.id} has no options.` }],
						details: { cancelled: true, answers },
					};
				}

				if (question.type === "radio") {
					const labels = options.map(optionText);
					if (question.allowOther !== false) labels.push("Other…");
					const selected = await ctx.ui.select(message, labels);
					if (selected === undefined) return cancelled(answers);
					if (selected === "Other…") {
						const other = await ctx.ui.input("Other", "Type your answer");
						if (other === undefined) return cancelled(answers);
						answers[question.id] = other.trim();
						continue;
					}
					const index = labels.indexOf(selected);
					answers[question.id] = optionValue(options[index]);
					continue;
				}

				const picked: string[] = [];
				for (const option of options) {
					const ok = await ctx.ui.confirm(question.question, `Include ${optionText(option)}?`);
					if (ok) picked.push(optionValue(option));
				}
				if (question.allowOther) {
					const hasOther = await ctx.ui.confirm(question.question, "Add another answer?");
					if (hasOther) {
						const other = await ctx.ui.input("Other", "Type another answer");
						if (other === undefined) return cancelled(answers);
						if (other.trim()) picked.push(other.trim());
					}
				}
				answers[question.id] = picked;
			}

			return {
				content: [{ type: "text" as const, text: `User answered:\n${JSON.stringify(answers, null, 2)}` }],
				details: { cancelled: false, answers },
			};
		},
	} as any);
}

function cancelled(answers: Record<string, Answer>) {
	return {
		content: [{ type: "text" as const, text: "User cancelled the question flow." }],
		details: { cancelled: true, answers },
	};
}
