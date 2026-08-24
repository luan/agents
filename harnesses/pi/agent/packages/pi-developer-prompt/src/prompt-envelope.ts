import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { DeveloperMessage } from "./developer-messages.ts";

const PROMPT_ENVELOPE_SERVICE_KEY = Symbol.for("pi-developer-prompt/envelope-service/v1");
const PROMPT_ENVELOPE_REQUESTS_KEY = Symbol.for("pi-developer-prompt/envelope-requests/v1");

export interface PromptEnvelopeRequest {
	provider?: string;
	activeTools: string[];
	sessionId: string;
	prompt?: string;
	cwd: string;
	piSystemPrompt?: string;
	systemPromptOptions: BuildSystemPromptOptions;
}

export interface PromptEnvelope {
	systemPrompt: string;
	developerMessages: DeveloperMessage[];
	contextualUserMessages: Array<{ id: string; content: string }>;
}

export interface PromptEnvelopeService {
	capture(request: PromptEnvelopeRequest): PromptEnvelope;
	current(
		sessionId: string,
		overrides?: Pick<PromptEnvelopeRequest, "provider" | "activeTools" | "cwd">,
	): PromptEnvelope | undefined;
	clear(sessionId: string): void;
}

export interface PromptEnvelopeRequestStore {
	readonly protocol: "pi-developer-prompt/envelope-requests/v1";
	readonly version: 1;
	get(sessionId: string): PromptEnvelopeRequest | undefined;
	set(sessionId: string, request: PromptEnvelopeRequest): void;
	delete(sessionId: string): void;
	clear(): void;
}

export function promptEnvelopeRequests(): PromptEnvelopeRequestStore {
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	const current = slots[PROMPT_ENVELOPE_REQUESTS_KEY];
	if (isRequestStore(current)) return current;
	const values = new Map<string, PromptEnvelopeRequest>();
	const requests: PromptEnvelopeRequestStore = {
		protocol: "pi-developer-prompt/envelope-requests/v1",
		version: 1,
		get: (sessionId) => values.get(sessionId),
		set: (sessionId, request) => {
			values.set(sessionId, request);
		},
		delete: (sessionId) => {
			values.delete(sessionId);
		},
		clear: () => {
			values.clear();
		},
	};
	slots[PROMPT_ENVELOPE_REQUESTS_KEY] = requests;
	return requests;
}

export function registerPromptEnvelopeService(service: PromptEnvelopeService): () => void {
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	slots[PROMPT_ENVELOPE_SERVICE_KEY] = service;
	return () => {
		if (slots[PROMPT_ENVELOPE_SERVICE_KEY] === service) delete slots[PROMPT_ENVELOPE_SERVICE_KEY];
	};
}

export function getPromptEnvelopeService(): PromptEnvelopeService | undefined {
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	const value = slots[PROMPT_ENVELOPE_SERVICE_KEY];
	return value &&
		typeof value === "object" &&
		"capture" in value &&
		typeof value.capture === "function" &&
		"current" in value &&
		typeof value.current === "function"
		? (value as PromptEnvelopeService)
		: undefined;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator avoids instanceof Map.
function isRequestStore(value: unknown): value is PromptEnvelopeRequestStore {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PromptEnvelopeRequestStore>;
	return (
		candidate.protocol === "pi-developer-prompt/envelope-requests/v1" &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function" &&
		typeof candidate.clear === "function"
	);
}
