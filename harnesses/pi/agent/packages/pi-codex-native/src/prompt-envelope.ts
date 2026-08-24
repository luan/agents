const PROMPT_ENVELOPE_SERVICE_KEY = Symbol.for("pi-developer-prompt/envelope-service/v1");

export interface PromptEnvelope {
	systemPrompt: string;
	developerMessages: Array<{ id: string; content: string }>;
	contextualUserMessages: Array<{ id: string; content: string }>;
}

interface PromptEnvelopeService {
	current(
		sessionId: string,
		overrides?: {
			provider?: string;
			activeTools: string[];
			cwd: string;
		},
	): PromptEnvelope | undefined;
}

export function resolveCurrentPromptEnvelope(
	sessionId: string,
	overrides: Parameters<PromptEnvelopeService["current"]>[1],
): { serviceAvailable: boolean; envelope?: PromptEnvelope } {
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	const value = slots[PROMPT_ENVELOPE_SERVICE_KEY];
	if (!value || typeof value !== "object" || !("current" in value) || typeof value.current !== "function") {
		return { serviceAvailable: false };
	}
	const envelope = (value as PromptEnvelopeService).current(sessionId, overrides);
	return envelope ? { serviceAvailable: true, envelope } : { serviceAvailable: true };
}
