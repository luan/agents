import type { AskParams } from "../types";
import { createInitialState as createBaseState } from "./navigation";
import { normalizeQuestions } from "./normalize";

export function createInitialState(params: AskParams) {
	return createBaseState({
		title: params.title,
		questions: normalizeQuestions(params),
	});
}
