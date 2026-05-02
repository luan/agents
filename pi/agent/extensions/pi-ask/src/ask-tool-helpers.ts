import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { renderResultText } from "./result";
import { createInitialState } from "./state/create";
import { collectValidationIssues } from "./state/normalize";
import { summarizeResult, toAskResult } from "./state/result";
import type { AskParams, AskQuestionInput, AskResult, AskValidationIssue } from "./types";
import { UI_DIMENSIONS } from "./ui/constants";

export const ASK_TOOL_DESCRIPTION =
	"Interactive clarification tool for cases where the next step depends on user preferences, missing requirements, or choosing between multiple valid directions. Ask a short structured interview, collect normalized answers, and continue using those answers explicitly instead of guessing. Supports single-select, multi-select, and preview-pane questions. Always include a machine-readable `value` for every option. Use `preview` only when every option includes `preview` text; descriptions alone are not enough.";

export const ASK_TOOL_PROMPT_GUIDELINES = [
	"Use this tool before making preference-sensitive decisions about scope, tone, UX, naming, architecture, docs, or implementation direction.",
	"When multiple valid directions exist, ask 1-3 concise questions instead of committing to one path on your own.",
	"Prefer one focused decision per question and use short labels with 2-4 clear options.",
	"Always include a non-empty `value` for every option.",
	'Use `type: "single"` by default and `type: "multi"` only when several answers can genuinely apply.',
	'Use `type: "preview"` only when every option includes non-empty `preview` text for the dedicated preview pane. Option descriptions do not satisfy this requirement.',
	"After clarifying a note or follow-up question, prefer another structured ask_user follow-up if a choice is still needed instead of switching to plain-text multiple choice in chat.",
	"When prior answers already narrow the branch, bundle the next 2-3 related unresolved decisions into one follow-up ask instead of issuing a long sequence of single-question asks.",
	"Use one-at-a-time follow-up asks only when the next question materially depends on the previous answer.",
] as const;

export function validateParams(
	params: AskParams,
): { ok: true; state: ReturnType<typeof createInitialState> } | { ok: false; issues: AskValidationIssue[] } {
	const issues = collectValidationIssues(params);
	if (issues.length > 0) {
		return { ok: false, issues };
	}

	return {
		ok: true,
		state: createInitialState(params),
	};
}

export function invalidPayloadResponse(params: AskParams, issues: AskValidationIssue[]) {
	return {
		content: [{ type: "text" as const, text: formatValidationError(issues) }],
		details: errorResultDetails(params, issues),
	};
}

export function nonInteractiveResponse(state: ReturnType<typeof createInitialState>) {
	return {
		content: [{ type: "text" as const, text: formatNonInteractiveMessage(state) }],
		details: {
			...toAskResult(state),
			cancelled: true,
		},
	};
}

export function successfulResponse(result: AskResult) {
	return {
		content: [{ type: "text" as const, text: summarizeResult(result) }],
		details: result,
	};
}

type ToolTheme = ExtensionContext["ui"]["theme"];

export function renderAskToolCall(args: unknown, theme: ToolTheme) {
	const params = args as AskParams;
	const labels = Array.isArray(params.questions)
		? params.questions.map((question: AskQuestionInput, index) => question.label || `Q${index + 1}`).join(", ")
		: "";
	let text = theme.fg("toolTitle", theme.bold("Ask User "));
	text += theme.fg("muted", `${params.questions?.length ?? 0} question(s)`);
	if (labels) {
		text += theme.fg("dim", ` (${truncateToWidth(labels, UI_DIMENSIONS.callLabelTruncateWidth)})`);
	}
	return new Text(text, 0, 0);
}

export function renderAskToolResult(
	result: {
		content: Array<{ type?: string; text?: string }>;
		details?: AskResult;
	},
	_options: unknown,
	theme: ToolTheme,
	context?: { lastComponent?: unknown },
) {
	const textComponent = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const details = result.details;
	if (!details) {
		const text = result.content[0];
		textComponent.setText(text?.type === "text" ? (text.text ?? "") : "");
		return textComponent;
	}
	if (details.error) {
		textComponent.setText(theme.fg("warning", "Invalid input"));
		return textComponent;
	}
	if (details.cancelled) {
		textComponent.setText(theme.fg("warning", "Cancelled"));
		return textComponent;
	}
	textComponent.setText(renderResultBlock(details, theme));
	return textComponent;
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

function errorResultDetails(params: AskParams, issues: AskValidationIssue[]): AskResult {
	return {
		title: params.title,
		cancelled: true,
		mode: "submit",
		questions: [],
		answers: {},
		error: {
			kind: "invalid_input",
			issues,
		},
	};
}

function formatValidationError(issues: AskValidationIssue[]): string {
	return ["Invalid ask_user payload:", ...issues.map((issue) => `- ${issue.path}: ${issue.message}`)].join("\n");
}

function formatNonInteractiveMessage(state: ReturnType<typeof createInitialState>): string {
	const lines = [
		"Needs user input: ask_user requires interactive UI.",
		"Run same tool call in interactive session, or ask user these questions manually:",
	];

	for (const [index, question] of state.questions.entries()) {
		lines.push(`${index + 1}. ${question.label}: ${question.prompt}`);
		for (const option of question.options) {
			lines.push(`   - ${option.label} [${option.value}]`);
		}
		lines.push("   - Type your own [custom]");
	}

	lines.push(
		"details.questions contains normalized pending questions. details.answers stays empty until user responds.",
	);
	return lines.join("\n");
}
