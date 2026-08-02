export type OpenAIFastOverride = "auto" | "on" | "off";

export type OpenAIFastRequestEvent = {
	active: boolean;
	sessionFile?: string;
};

type OpenAIFastState = {
	override: OpenAIFastOverride;
	listeners: Set<(event: OpenAIFastRequestEvent) => void>;
};

const stateKey = Symbol.for("pi.openai-fast.state");
const globalState = globalThis as typeof globalThis & Record<symbol, OpenAIFastState | undefined>;

function getState(): OpenAIFastState {
	const existing = globalState[stateKey];
	if (existing) return existing;
	const created = { override: "auto" as const, listeners: new Set<(event: OpenAIFastRequestEvent) => void>() };
	globalState[stateKey] = created;
	return created;
}

export function getOpenAIFastOverride(): OpenAIFastOverride {
	return getState().override;
}

export function setOpenAIFastOverride(override: OpenAIFastOverride): void {
	getState().override = override;
}

export function emitOpenAIFastRequest(event: OpenAIFastRequestEvent): void {
	for (const listener of getState().listeners) listener(event);
}

export function onOpenAIFastRequest(listener: (event: OpenAIFastRequestEvent) => void): () => void {
	getState().listeners.add(listener);
	return () => getState().listeners.delete(listener);
}
