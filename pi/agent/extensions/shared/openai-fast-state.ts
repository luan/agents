export type OpenAIFastOverride = "auto" | "on" | "off";

export type OpenAIFastRequestEvent = {
	active: boolean;
	sessionFile?: string;
};
export type OpenAIFastRoleEvent = {
	active: boolean;
	sessionFile?: string;
};

type OpenAIFastState = {
	override: OpenAIFastOverride;
	listeners: Set<(event: OpenAIFastRequestEvent) => void>;
	roleFastBySession: Map<string, boolean>;
	roleListeners: Set<(event: OpenAIFastRoleEvent) => void>;
};

const stateKey = Symbol.for("pi.openai-fast.state");
const globalState = globalThis as typeof globalThis & Record<symbol, OpenAIFastState | undefined>;

function getState(): OpenAIFastState {
	const existing = globalState[stateKey];
	if (existing) {
		existing.roleFastBySession ??= new Map();
		existing.roleListeners ??= new Set();
		return existing;
	}
	const created: OpenAIFastState = {
		override: "auto",
		listeners: new Set(),
		roleFastBySession: new Map(),
		roleListeners: new Set(),
	};
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
export function setOpenAIFastRoleEnabled(event: OpenAIFastRoleEvent): void {
	const state = getState();
	const key = event.sessionFile ?? "";
	if (event.active) state.roleFastBySession.set(key, true);
	else state.roleFastBySession.delete(key);
	for (const listener of state.roleListeners) listener(event);
}

export function getOpenAIFastRoleEnabled(sessionFile?: string): boolean {
	return getState().roleFastBySession.get(sessionFile ?? "") === true;
}

export function onOpenAIFastRoleChange(listener: (event: OpenAIFastRoleEvent) => void): () => void {
	getState().roleListeners.add(listener);
	return () => getState().roleListeners.delete(listener);
}
