import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComponentStack } from "@luan.sh/pi-libtui";
import { settleToolCallPreview, ToolActivity, toolCallPreview, type ToolActivityView } from "@luan.sh/pi-libtui/tool";
import type { TSchema } from "typebox";
import type { ConversationDetails } from "./result.ts";

type ConversationTool = "request_user_input_async" | "send_message_to_user_async" | "clock__curr_time" | "clock__sleep";
const labels: Record<ConversationTool, string> = {
	request_user_input_async: "Ask for input",
	send_message_to_user_async: "Send message",
	clock__curr_time: "Check time",
	clock__sleep: "Wait",
};

export function conversationPresentation<Schema extends TSchema>(
	tool: ConversationTool,
): Pick<ToolDefinition<Schema, ConversationDetails>, "renderShell" | "renderCall" | "renderResult"> {
	return {
		renderShell: "self",
		renderCall(_args, theme, context) {
			if (context.executionStarted) return new ComponentStack();
			return toolCallPreview(
				context.state,
				new ToolActivity({
					theme,
					requestRender: context.invalidate,
					view: { action: { verb: labels[tool], status: "queued" } },
				}),
			);
		},
		renderResult(result, options, theme, context) {
			settleToolCallPreview(context.state);
			const details = result.details;
			const failed = context.isError || !details || details.version !== 1 || details.tool !== tool;
			const view: ToolActivityView = failed
				? {
						action: { verb: `${labels[tool]} failed`, status: "failed" },
						mode: options.expanded ? "full" : "preview",
						failure: result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
					}
				: conversationView(details, options.expanded);
			return ToolActivity.reuse(context.lastComponent, {
				theme,
				requestRender: context.invalidate,
				view,
				previewRows: 3,
			});
		},
	};
}

function conversationView(details: ConversationDetails, expanded: boolean): ToolActivityView {
	if (details.status === "running")
		return {
			action: { verb: "Waiting", detail: `up to ${duration(details.duration_ms)}`, status: "running" },
			running: true,
		};
	const output = details.output;
	if ("elapsed_ms" in output)
		return {
			action: {
				verb:
					output.reason === "input"
						? "Resumed on your input"
						: output.reason === "cancelled"
							? "Wait cancelled"
							: "Waited",
				detail: duration(output.elapsed_ms),
				status: output.reason === "cancelled" ? "warning" : "succeeded",
			},
		};
	if ("current_time" in output)
		return {
			action: { verb: "Checked time", detail: output.current_time, status: "succeeded" },
		};
	if (details.tool === "send_message_to_user_async")
		return {
			// The durable message entry renders the message itself once.
			action: { verb: "Sent message", status: "succeeded" },
		};
	const questions = details.questions ?? [];
	return {
		action: {
			verb: "Asked for input",
			detail: questions[0]?.title,
			status: "succeeded",
			meta: questions.length > 1 ? [`${questions.length} questions`] : undefined,
		},
		payload: questions.length
			? {
					kind: "text",
					text: questions
						.map((question) => [question.title, ...(question.options ?? []).map((option) => `• ${option}`)].join("\n"))
						.join("\n\n"),
					revision: 0,
				}
			: undefined,
		mode: expanded ? "full" : "preview",
	};
}

function duration(milliseconds: number): string {
	if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1).replace(/\.0$/, "")}s`;
	if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1).replace(/\.0$/, "")}m`;
	return `${(milliseconds / 3_600_000).toFixed(1).replace(/\.0$/, "")}h`;
}
