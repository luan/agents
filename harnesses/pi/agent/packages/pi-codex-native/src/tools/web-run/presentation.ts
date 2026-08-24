import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon, sanitizeTuiText } from "pi-libtui";
import { settleToolCallPreview, ToolActivity, ToolTranscript, toolCallPreview } from "pi-libtui/tool";
import type { WebRunToolDetails } from "./result.ts";
import type { WebRunParameters } from "./schema.ts";

interface PresentationContext {
	readonly executionStarted: boolean;
	readonly state?: object;
	readonly args?: WebRunParameters;
	readonly isError: boolean;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
}

export function renderWebRunCall(request: WebRunParameters, theme: Theme, context: PresentationContext) {
	if (context.executionStarted) return new ComponentStack();
	const summary = requestSummary(request);
	return toolCallPreview(
		context.state ?? context,
		new ToolTranscript({
			theme,
			view: {
				verb: "Search the web",
				status: "queued",
				marker: icon("search"),
				detail: summary.detail,
				meta: summary.operations.length > 1 ? [`${summary.operations.length} operations`] : undefined,
			},
		}),
	);
}

export function renderWebRunResult(
	result: AgentToolResult<WebRunToolDetails>,
	theme: Theme,
	context: PresentationContext,
	expanded: boolean,
) {
	settleToolCallPreview(context.state ?? context);
	const details = result.details;
	const validDetails = isWebRunDetails(details);
	const summary = requestSummary(validDetails ? details.request : (context.args ?? {}));
	const output = (Array.isArray(result.content) ? result.content : [])
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const type = Reflect.get(item, "type");
			const text = Reflect.get(item, "text");
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
	const displayOutput = sanitizeTuiText(cleanWebOutput(output));
	const failed = context.isError || !validDetails;
	const view = {
		action: {
			verb: failed ? "Web request failed" : webVerb(summary.operations),
			status: failed ? ("failed" as const) : ("succeeded" as const),
			marker: icon("search"),
			detail: summary.detail,
			meta: validDetails
				? [formatDuration(details.timing.durationMs), ...(details.output.textTruncated ? ["truncated"] : [])]
				: undefined,
		},
		running: false,
		payload:
			displayOutput && !failed
				? {
						kind: "text" as const,
						text: displayOutput,
						revision: validDetails ? details.output.textChars + details.timing.durationMs : displayOutput.length,
					}
				: undefined,
		failure: failed ? displayOutput || "Web request failed" : undefined,
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
	return ToolActivity.reuse(context.lastComponent, {
		theme,
		requestRender: context.invalidate,
		view,
		previewRows: 4,
		fullRows: 1_000,
	});
}

function isWebRunDetails(details: WebRunToolDetails | undefined): details is WebRunToolDetails {
	return Boolean(
		details &&
			typeof details === "object" &&
			details.version === 1 &&
			details.tool === "web__run" &&
			details.request &&
			typeof details.request === "object" &&
			details.timing &&
			typeof details.timing.durationMs === "number" &&
			details.output &&
			typeof details.output.textChars === "number",
	);
}

function requestSummary(request: WebRunParameters): { operations: string[]; detail?: string } {
	const operations = Object.entries(request)
		.filter(
			([name, value]) => name !== "settings" && name !== "response_length" && Array.isArray(value) && value.length > 0,
		)
		.map(([name]) => name);
	const firstOperation = operations[0];
	const candidates = firstOperation ? Reflect.get(request, firstOperation) : undefined;
	const first = Array.isArray(candidates) ? candidates[0] : undefined;
	const detail = first && typeof first === "object" ? operationDetail(first) : undefined;
	return { operations, detail };
}

function operationDetail(value: object): string | undefined {
	for (const key of ["q", "location", "ticker", "utc_offset", "ref_id", "team", "league"] as const) {
		const detail = Reflect.get(value, key);
		if (typeof detail === "string" && detail.trim()) return detail;
	}
	return undefined;
}

/** Remove provider-only citation sentinels while preserving their readable text. */
export function cleanWebOutput(text: string): string {
	return text
		.replace(/\uE200(?:cite|turn|source|image|forecast)\uE202[^\uE201]*\uE201/gu, "")
		.replace(/[\uE200\uE201\uE202]/gu, "")
		.trim();
}

function webVerb(operations: readonly string[]): string {
	if (operations.length !== 1) return "Used the web";
	switch (operations[0]) {
		case "search_query":
			return "Searched the web";
		case "image_query":
			return "Searched images";
		case "weather":
			return "Checked weather";
		case "finance":
			return "Checked markets";
		case "sports":
			return "Checked sports";
		case "time":
			return "Checked time";
		case "open":
			return "Opened a source";
		case "click":
			return "Followed a source link";
		case "find":
			return "Searched within a source";
		case "screenshot":
			return "Captured a source page";
		default:
			return "Used the web";
	}
}

function formatDuration(milliseconds: number): string {
	return milliseconds < 1_000 ? `${Math.max(0, Math.round(milliseconds))}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}
