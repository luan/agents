import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

const PROMPT_ENVELOPE_SERVICE_KEY = Symbol.for("pi-developer-prompt/envelope-service/v1");

export interface PromptEnvelopePrimeRequest {
	provider?: string;
	activeTools: string[];
	sessionId: string;
	prompt?: string;
	cwd: string;
	piSystemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

interface PromptEnvelopeService {
	capture(request: PromptEnvelopePrimeRequest): object;
}

export function primePromptEnvelope(request: PromptEnvelopePrimeRequest): void {
	const value = (globalThis as Record<symbol, UntrustedPromptEnvelopeService>)[PROMPT_ENVELOPE_SERVICE_KEY];
	if (isPromptEnvelopeService(value)) value.capture(request);
}

// type-boundary: pi-developer-prompt owns this optional Symbol.for capability; isPromptEnvelopeService validates it immediately.
type UntrustedPromptEnvelopeService = unknown;

function isPromptEnvelopeService(value: UntrustedPromptEnvelopeService): value is PromptEnvelopeService {
	return Boolean(value && typeof value === "object" && "capture" in value && typeof value.capture === "function");
}
