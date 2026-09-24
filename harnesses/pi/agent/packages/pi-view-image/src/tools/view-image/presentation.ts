import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon } from "@luan.sh/pi-libtui";
import { settleToolCallPreview, ToolActivity, toolCallPreview } from "@luan.sh/pi-libtui/tool";
import { VIEW_IMAGE_ICON, VIEW_IMAGE_ICON_TONE } from "../../core/appearance.ts";
import type { ViewImageDetails } from "./result.ts";

interface ViewImageRenderContext {
	readonly executionStarted: boolean;
	readonly state: object;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
	readonly isError: boolean;
	readonly expanded?: boolean;
}

export function renderViewImageCall(args: { readonly path?: string }, theme: Theme, context: ViewImageRenderContext) {
	if (context.executionStarted) return new ComponentStack();
	return toolCallPreview(
		context.state,
		new ToolActivity({
			theme,
			requestRender: context.invalidate,
			view: {
				action: {
					verb: "View image",
					detail: basename(args.path ?? ""),
					status: "queued",
					marker: icon(VIEW_IMAGE_ICON),
					markerTone: VIEW_IMAGE_ICON_TONE,
				},
			},
		}),
	);
}

export function renderViewImageResult(
	result: AgentToolResult<ViewImageDetails>,
	theme: Theme,
	context: ViewImageRenderContext,
) {
	settleToolCallPreview(context.state);
	const details = result.details;
	const failed = context.isError || !details || typeof details.timing?.durationMs !== "number";
	return ToolActivity.reuse(context.lastComponent, {
		theme,
		requestRender: context.invalidate,
		view: {
			...(details?.description
				? {
						payload: { kind: "text" as const, text: details.description.text, revision: 1 },
						mode: context.expanded ? ("full" as const) : ("preview" as const),
					}
				: {}),
			action: {
				verb: failed ? "View image failed" : details.description ? "Described image" : "Viewed image",
				detail: details?.description?.model,
				status: failed ? "failed" : "succeeded",
				marker: icon(VIEW_IMAGE_ICON),
				markerTone: VIEW_IMAGE_ICON_TONE,
				meta: failed ? undefined : [`${Math.max(0, Math.round(details.timing.durationMs))}ms`],
			},
		},
	});
}

function basename(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}
