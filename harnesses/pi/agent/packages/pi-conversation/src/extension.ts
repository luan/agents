import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAction } from "@luan.sh/pi-libactions/sdk";
import { ComponentStack, MarkdownText } from "@luan.sh/pi-libtui";
import { ToolTranscript } from "@luan.sh/pi-libtui/tool";
import { registerConversationPrompt } from "./contributions/prompt.ts";
import { ANSWER_ENTRY, answerData, MESSAGE_ENTRY } from "./core/state.ts";
import { Conversation } from "./runtime/conversation.ts";
import { registerCurrentTimeTool } from "./tools/current-time/definition.ts";
import { registerQuestionTool } from "./tools/request-user-input/definition.ts";
import { registerMessageTool } from "./tools/send-user-message/definition.ts";
import { registerSleepTool } from "./tools/sleep/definition.ts";
import { ConversationUI } from "./ui/questions.ts";
import { answerRpcQuestions } from "./ui/rpc-questions.ts";

export default function conversationExtension(pi: ExtensionAPI): void {
	const conversation = new Conversation(pi);
	const ui = new ConversationUI(conversation);
	let actionDisposers: (() => void)[] = [];
	let dialogOpen = false;
	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			ui.focus(ctx);
			return;
		}
		if (dialogOpen) return;
		dialogOpen = true;
		try {
			await answerRpcQuestions(ctx, conversation);
		} finally {
			dialogOpen = false;
		}
	};
	const disposers = [
		registerConversationPrompt(pi),
		conversation.onChange((ctx) => {
			ui.update(ctx);
			if (ctx.mode === "rpc" && ctx.hasUI && conversation.pending(ctx).length)
				void open(ctx).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
		}),
	];
	registerQuestionTool(pi, conversation);
	registerMessageTool(pi, conversation);
	registerSleepTool(pi, conversation);
	registerCurrentTimeTool(pi);
	pi.registerCommand("questions", {
		description: "Answer pending questions; /questions dismiss dismisses the oldest group",
		handler: async (args, ctx) => {
			if (args.trim() === "dismiss") {
				const group = conversation.pending(ctx)[0];
				if (group) conversation.answer(ctx, group, [], true);
			} else await open(ctx);
		},
	});
	pi.registerEntryRenderer(ANSWER_ENTRY, (entry, _options, theme) => {
		const answer = answerData(entry.data);
		if (!answer) return new ComponentStack();
		return new ToolTranscript({
			theme,
			view: {
				verb: answer.dismissed ? "Question dismissed" : "You answered",
				detail: answer.dismissed ? undefined : answer.answers.join(" · "),
				status: answer.dismissed ? "warning" : "succeeded",
			},
		});
	});
	pi.registerEntryRenderer<{ version: 1; id: string; message: string }>(
		MESSAGE_ENTRY,
		(entry, _options, theme) =>
			new MarkdownText({ theme, text: typeof entry.data?.message === "string" ? entry.data.message : "" }),
	);
	pi.on("session_start", (_event, ctx) => {
		ui.dispose();
		for (const dispose of actionDisposers) dispose();
		actionDisposers = [];
		if (ctx.mode === "tui" && ctx.hasUI)
			actionDisposers = [
				registerAction({ id: "conversation.questions.open", description: "Answer pending questions", run: open }),
			];
		ui.update(ctx);
	});
	pi.on("session_before_switch", (_event, ctx) => {
		conversation.wake(ctx);
	});
	pi.on("session_before_fork", (_event, ctx) => {
		conversation.wake(ctx);
	});
	pi.on("session_before_tree", (_event, ctx) => {
		conversation.wake(ctx);
	});
	pi.on("input", (_event, ctx) => {
		conversation.wake(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		conversation.wake(ctx);
		ui.dispose();
		for (const dispose of actionDisposers) dispose();
		actionDisposers = [];
		for (const dispose of disposers) dispose();
	});
}
