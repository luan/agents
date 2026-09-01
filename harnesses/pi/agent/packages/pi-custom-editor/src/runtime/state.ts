export interface WorkingSnapshot {
	active: boolean;
	startedAtMs?: number;
	lastTurnMs?: number;
	cumulativeMs: number;
}

export class TuiState {
	active = false;
	startedAtMs: number | undefined;
	lastTurnMs: number | undefined;
	cumulativeMs = 0;
	branch: string | undefined;
	roleStatus: string | undefined;
	contextStatus: string | undefined;
	fastMode = false;
	revision = 0;

	reset(): void {
		this.active = false;
		this.startedAtMs = undefined;
		this.lastTurnMs = undefined;
		this.cumulativeMs = 0;
		this.branch = undefined;
		this.roleStatus = undefined;
		this.contextStatus = undefined;
		this.fastMode = false;
		this.revision++;
	}

	setModelStatus(roleStatus: string | undefined, contextStatus: string | undefined, fastMode: boolean): void {
		if (this.roleStatus === roleStatus && this.contextStatus === contextStatus && this.fastMode === fastMode) return;
		this.roleStatus = roleStatus;
		this.contextStatus = contextStatus;
		this.fastMode = fastMode;
		this.revision++;
	}

	start(now = Date.now()): void {
		this.active = true;
		this.startedAtMs = now;
		this.revision++;
	}

	stop(now = Date.now()): void {
		if (this.startedAtMs !== undefined) {
			this.lastTurnMs = Math.max(0, now - this.startedAtMs);
			this.cumulativeMs += this.lastTurnMs;
		}
		this.active = false;
		this.startedAtMs = undefined;
		this.revision++;
	}

	elapsed(now = Date.now()): number {
		return this.startedAtMs === undefined ? 0 : Math.max(0, now - this.startedAtMs);
	}

	snapshot(now = Date.now()): WorkingSnapshot {
		return {
			active: this.active,
			startedAtMs: this.startedAtMs,
			lastTurnMs: this.active ? this.elapsed(now) : this.lastTurnMs,
			cumulativeMs: this.cumulativeMs + (this.active ? this.elapsed(now) : 0),
		};
	}
}

export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds >= 3600)
		return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
	if (seconds >= 60) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${seconds}s`;
}
