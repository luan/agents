export type GenerationRateSnapshot = {
	lastTurnTps?: number;
	overallTps?: number;
};

export class GenerationRateStats {
	private messageOpenedAt: number | undefined;
	private firstTokenAt: number | undefined;
	private turnTokens = 0;
	private turnDurationMs = 0;
	private totalTokens = 0;
	private totalDurationMs = 0;
	private lastTurnTps: number | undefined;

	startMessage(at = Date.now()): void {
		this.messageOpenedAt = at;
		this.firstTokenAt = undefined;
	}

	markFirstToken(at = Date.now()): void {
		if (this.messageOpenedAt !== undefined && this.firstTokenAt === undefined) this.firstTokenAt = at;
	}

	finishMessage(outputTokens: number, at = Date.now()): void {
		const startedAt = this.firstTokenAt ?? this.messageOpenedAt;
		if (startedAt === undefined || !Number.isFinite(outputTokens) || outputTokens < 0) return;
		const durationMs = Math.max(1, at - startedAt);
		this.messageOpenedAt = undefined;
		this.firstTokenAt = undefined;
		this.turnTokens += outputTokens;
		this.turnDurationMs += durationMs;
		this.totalTokens += outputTokens;
		this.totalDurationMs += durationMs;
	}

	recordMessage(outputTokens: number, durationMs: number): void {
		if (!Number.isFinite(outputTokens) || outputTokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
		this.turnTokens += outputTokens;
		this.turnDurationMs += durationMs;
		this.totalTokens += outputTokens;
		this.totalDurationMs += durationMs;
	}

	finishTurn(): void {
		if (this.turnDurationMs > 0) this.lastTurnTps = this.turnTokens / (this.turnDurationMs / 1000);
		this.turnTokens = 0;
		this.turnDurationMs = 0;
	}

	snapshot(): GenerationRateSnapshot {
		const currentTurnTps =
			this.turnDurationMs > 0 ? this.turnTokens / (this.turnDurationMs / 1000) : this.lastTurnTps;
		return {
			lastTurnTps: currentTurnTps,
			overallTps: this.totalDurationMs > 0 ? this.totalTokens / (this.totalDurationMs / 1000) : undefined,
		};
	}

	reset(): void {
		this.messageOpenedAt = undefined;
		this.firstTokenAt = undefined;
		this.turnTokens = 0;
		this.turnDurationMs = 0;
		this.totalTokens = 0;
		this.totalDurationMs = 0;
		this.lastTurnTps = undefined;
	}
}
