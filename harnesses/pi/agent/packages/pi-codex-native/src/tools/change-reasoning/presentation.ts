import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComponentStack } from "@luan.sh/pi-libtui";
import { ToolActivity, toolCallPreview, settleToolCallPreview } from "@luan.sh/pi-libtui/tool";
import type { TSchema } from "typebox";
import type { ReasoningDetails } from "./definition.ts";
export function reasoningPresentation<Schema extends TSchema>(): Pick<
	ToolDefinition<Schema, ReasoningDetails>,
	"renderShell" | "renderCall" | "renderResult"
> {
	return {
		renderShell: "self",
		renderCall(_args, theme, context) {
			return context.executionStarted
				? new ComponentStack()
				: toolCallPreview(
						context.state,
						new ToolActivity({
							theme,
							requestRender: context.invalidate,
							view: { action: { verb: "Adjust reasoning", status: "queued" } },
						}),
					);
		},
		renderResult(result, options, theme, context) {
			settleToolCallPreview(context.state);
			const failed = context.isError || !result.details;
			return ToolActivity.reuse(context.lastComponent, {
				theme,
				requestRender: context.invalidate,
				view: {
					action: {
						verb: failed ? "Reasoning adjustment failed" : "Adjusted reasoning",
						status: failed ? "failed" : "succeeded",
						detail: result.details ? `${result.details.level} · user floor ${result.details.floor}` : undefined,
					},
					mode: options.expanded ? "full" : "preview",
					...(failed
						? {
								failure: result.content
									.filter((item) => item.type === "text")
									.map((item) => item.text)
									.join("\n"),
							}
						: {}),
				},
			});
		},
	};
}
