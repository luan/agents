export type OpenAIFastOverride = "auto" | "on" | "off";

let runtimeOverride: OpenAIFastOverride = "auto";

export function getOpenAIFastOverride(): OpenAIFastOverride {
	return runtimeOverride;
}

export function setOpenAIFastOverride(override: OpenAIFastOverride): void {
	runtimeOverride = override;
}

export const OPENAI_FAST_REQUEST_EVENT = "openai-fast:request";

export type OpenAIFastRequestEvent = {
	active: boolean;
	sessionFile?: string;
};
