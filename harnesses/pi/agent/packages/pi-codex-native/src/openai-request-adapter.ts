import type { Api, Model } from "@earendil-works/pi-ai";

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : undefined;
}

export type OpenAIRequestAdapter = {
	applyVerbosity(payload: unknown, verbosity: string): unknown;
};

/** Wire adaptation for the OpenAI APIs exposed by pi-ai. Unknown APIs are not guessed. */
export function openAIRequestAdapter(model: Model<Api> | undefined): OpenAIRequestAdapter | undefined {
	if (!model) return undefined;
	if (model.api === "openai-completions") {
		return {
			applyVerbosity(payload, verbosity) {
				const body = record(payload);
				return body ? { ...body, verbosity } : payload;
			},
		};
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return {
			applyVerbosity(payload, verbosity) {
				const body = record(payload);
				if (!body) return payload;
				const text = record(body.text);
				return { ...body, text: { ...text, verbosity } };
			},
		};
	}
	return undefined;
}
