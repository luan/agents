import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { textComponent } from "../../shared/tui";
import { CANCELLED_RESULT_TEXT, ELABORATED_RESULT_TEXT, SUBMITTED_RESULT_TEXT } from "./constants";
import { formatElaborationLines, formatResultLines } from "./result-format";
import type { AskParams, AskQuestionInput, AskResult } from "./types";
import { UI_DIMENSIONS } from "./ui/constants";

type ToolTheme = ExtensionContext["ui"]["theme"];

export const askToolPresentation = {
	renderShell: "self" as const,
	renderCall: renderAskToolCall,
	renderResult: renderAskToolResult,
};

function renderAskToolCall(args: unknown, theme: ToolTheme) {
	const params = args as AskParams;
	const labels = Array.isArray(params.questions)
		? params.questions.map((question: AskQuestionInput, index) => question.label || `Q${index + 1}`).join(", ")
		: "";
	let text = theme.fg("toolTitle", theme.bold("Ask User "));
	text += theme.fg("muted", `${params.questions?.length ?? 0} question(s)`);
	if (labels) {
		text += theme.fg("dim", ` (${truncateToWidth(labels, UI_DIMENSIONS.callLabelTruncateWidth)})`);
	}
	return textComponent(text);
}

function renderAskToolResult(
	result: {
		content: Array<{ type?: string; text?: string }>;
		details?: AskResult;
	},
	_options: unknown,
	theme: ToolTheme,
	context?: { lastComponent?: unknown },
) {
	const textComponentInstance = context?.lastComponent instanceof Text ? context.lastComponent : textComponent("");
	const details = result.details;
	if (!details) {
		const text = result.content[0];
		textComponentInstance.setText(text?.type === "text" ? (text.text ?? "") : "");
		return textComponentInstance;
	}
	if (details.error) {
		textComponentInstance.setText(theme.fg("warning", "Invalid input"));
		return textComponentInstance;
	}
	if (details.cancelled) {
		textComponentInstance.setText(theme.fg("warning", "Cancelled"));
		return textComponentInstance;
	}
	textComponentInstance.setText(renderResultBlock(details, theme));
	return textComponentInstance;
}

function renderResultBlock(result: AskResult, theme: ToolTheme): string {
	const body = renderResultText(result).split("\n");
	const title = result.mode === "elaborate" ? "Ask User — Elaboration" : "Ask User";
	const lines = [theme.fg("toolTitle", theme.bold(title))];
	for (const [index, line] of body.entries()) {
		const prefix = index === body.length - 1 ? "  └ " : "  ├ ";
		lines.push(`${theme.fg("dim", prefix)}${line}`);
	}
	return lines.join("\n");
}

function renderResultText(result: AskResult): string {
	if (result.error) {
		return "Invalid input";
	}
	if (result.cancelled) {
		return CANCELLED_RESULT_TEXT;
	}
	if (result.mode === "elaborate") {
		const lines = formatElaborationLines(result, { mode: "render" });
		return lines.join("\n") || ELABORATED_RESULT_TEXT;
	}

	const lines = formatResultLines(result, { mode: "render" });
	return lines.join("\n") || SUBMITTED_RESULT_TEXT;
}
