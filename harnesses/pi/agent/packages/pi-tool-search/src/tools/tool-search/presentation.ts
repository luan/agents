import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon } from "pi-libtui";
import { settleToolCallPreview, ToolActivity, ToolTranscript, toolCallPreview } from "pi-libtui/tool";
import type { ToolSearchDetails } from "./result.ts";

interface PresentationContext {
	readonly executionStarted: boolean;
	readonly state?: object;
	readonly args?: { readonly query?: string };
	readonly isError: boolean;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
}

export function renderToolSearchCall(query: string, theme: Theme, context: PresentationContext) {
	if (context.executionStarted) return new ComponentStack();
	return toolCallPreview(
		context.state ?? context,
		new ToolTranscript({
			theme,
			view: {
				verb: "Search tools",
				detail: query,
				status: "queued",
				marker: icon("search"),
			},
		}),
	);
}

export function renderToolSearchResult(
	result: AgentToolResult<ToolSearchDetails>,
	theme: Theme,
	context: PresentationContext,
	expanded: boolean,
) {
	settleToolCallPreview(context.state ?? context);
	const details = result.details;
	if (!isToolSearchDetails(details)) {
		return ToolActivity.reuse(context.lastComponent, {
			theme,
			requestRender: context.invalidate,
			view: {
				action: {
					verb: "Tool search failed",
					detail: context.args?.query,
					status: "failed",
					marker: icon("search"),
				},
				failure: resultText(result) || "Tool search failed",
			},
		});
	}
	const failed = context.isError;
	const noMatch = details.status === "no_match";
	const verb = failed ? "Tool search failed" : noMatch ? "No tools found" : "Loaded tools";
	const rows = details.rankedMatches.map((match) => `${match.name}  ${match.description}`);
	const view = {
		action: {
			verb,
			detail: details.input.query,
			status: failed ? ("failed" as const) : noMatch ? ("warning" as const) : ("succeeded" as const),
			marker: icon("search"),
			meta: [`${details.counts.matches} matches`, formatDuration(details.timing.durationMs)],
		},
		running: false,
		payload: rows.length
			? { kind: "text" as const, text: rows.join("\n"), revision: details.activation.after.length + rows.length }
			: undefined,
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
	return ToolActivity.reuse(context.lastComponent, {
		theme,
		requestRender: context.invalidate,
		view,
		previewRows: 4,
	});
}

function isToolSearchDetails(details: ToolSearchDetails | undefined): details is ToolSearchDetails {
	if (!details || typeof details !== "object") return false;
	return (
		details.version === 2 &&
		details.tool === "tool_search" &&
		(details.status === "loaded" || details.status === "no_match") &&
		typeof details.input?.query === "string" &&
		Array.isArray(details.rankedMatches) &&
		details.rankedMatches.every(
			(match) =>
				match !== null &&
				typeof match === "object" &&
				typeof match.name === "string" &&
				typeof match.description === "string",
		) &&
		Array.isArray(details.activation?.after) &&
		Number.isFinite(details.counts?.matches) &&
		Number.isFinite(details.timing?.durationMs)
	);
}

function resultText(result: AgentToolResult<ToolSearchDetails>): string {
	return (Array.isArray(result.content) ? result.content : [])
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const type = Reflect.get(item, "type");
			const text = Reflect.get(item, "text");
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1_000 ? `${Math.max(0, Math.round(milliseconds))}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}
