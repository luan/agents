import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon, MarkdownText } from "pi-libtui";
import { settleToolCallPreview, ToolActivity, toolCallPreview } from "pi-libtui/tool";
import type { SkillToolDetails } from "./definition.ts";

interface PresentationContext {
	readonly executionStarted: boolean;
	readonly state?: object;
	readonly args?: { readonly name?: string };
	readonly isError: boolean;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
}

export function renderSkillCall(name: string, theme: Theme, context: PresentationContext) {
	if (context.executionStarted) return new ComponentStack();
	return toolCallPreview(
		context.state ?? context,
		new ToolActivity({
			theme,
			requestRender: context.invalidate,
			view: { action: { verb: "Load skill", detail: name, status: "queued", marker: icon("lightbulb") } },
		}),
	);
}

export function renderSkillResult(
	result: AgentToolResult<SkillToolDetails>,
	theme: Theme,
	context: PresentationContext,
	expanded: boolean,
) {
	settleToolCallPreview(context.state ?? context);
	const details = result.details;
	if (!details || typeof details !== "object" || typeof details.name !== "string") {
		return ToolActivity.reuse(context.lastComponent, {
			theme,
			requestRender: context.invalidate,
			view: {
				action: {
					verb: "Skill failed",
					detail: context.args?.name,
					status: "failed",
				},
				failure: resultText(result) || "Skill failed",
			},
		});
	}
	const instructions = typeof details.instructions === "string" ? details.instructions : "";
	const loadedChars = typeof details.loadedChars === "number" ? details.loadedChars : instructions.length;
	const loadedTokens =
		typeof details.loadedTokens === "number" ? details.loadedTokens : Math.max(1, Math.ceil(loadedChars / 4));
	const view = {
		action: {
			verb: context.isError ? "Skill failed" : "Skill",
			detail: details.name,
			status: context.isError ? ("failed" as const) : ("succeeded" as const),
			marker: context.isError ? undefined : icon("lightbulb"),
			meta: [formatTokens(loadedTokens)],
		},
		running: false,
		payload: instructions
			? {
					kind: "component" as const,
					preview: new ComponentStack(),
					full: new MarkdownText({ theme, text: instructions, maxRows: 2_000 }),
				}
			: undefined,
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
	return ToolActivity.reuse(context.lastComponent, {
		theme,
		requestRender: context.invalidate,
		view,
	});
}

function resultText(result: AgentToolResult<SkillToolDetails>): string {
	return (Array.isArray(result.content) ? result.content : [])
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const type = Reflect.get(item, "type");
			const text = Reflect.get(item, "text");
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

export function renderSkillFailure(name: string, error: string, theme: Theme, context: PresentationContext) {
	return ToolActivity.reuse(context.lastComponent, {
		theme,
		requestRender: context.invalidate,
		view: {
			action: { verb: "Skill failed", detail: name, status: "failed" },
			failure: error,
		},
	});
}
function formatTokens(tokens: number): string {
	return tokens < 1_000 ? `${tokens} tokens` : `${(tokens / 1_000).toFixed(1)}k tokens`;
}
