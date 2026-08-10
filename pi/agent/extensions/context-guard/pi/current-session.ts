let currentSessionId: string | undefined;

export function getCurrentContextGuardSessionId(): string | undefined {
	return currentSessionId;
}

export function setCurrentContextGuardSessionId(sessionId: string | undefined): void {
	currentSessionId = sessionId;
}
