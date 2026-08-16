import { createInitialState } from "./state/create";
import { collectValidationIssues } from "./state/normalize";
import { summarizeResult, toAskResult } from "./state/result";
import type { AskParams, AskResult, AskValidationIssue } from "./types";

export const ASK_TOOL_DESCRIPTION =
	"Ask a short interactive clarification when user preference or missing requirements block a decision. Supports single, multi, and preview questions. Options need value+label; preview questions need preview on every option.";

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
