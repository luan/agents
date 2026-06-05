export interface AnimationMountOptions {
	id: string;
	intervalMs: number;
	onFrame(frame: number): void;
}

export interface AnimationMount {
	dispose(): void;
}

interface AnimationEntry extends AnimationMountOptions {
	frame: number;
	nextFrameAt?: number;
}

export class AnimationScheduler {
	private entries = new Map<string, AnimationEntry>();

	mount(options: AnimationMountOptions): AnimationMount {
		this.entries.set(options.id, { ...options, frame: 0 });
		return {
			dispose: () => {
				this.entries.delete(options.id);
			},
		};
	}

	nextDelay(now: number): number | undefined {
		for (const entry of this.entries.values()) {
			entry.nextFrameAt ??= now + entry.intervalMs;
		}
		const next = this.nextFrameAt(now);
		return next === undefined ? undefined : Math.max(0, next - now);
	}

	tick(now: number): void {
		for (const entry of this.entries.values()) {
			entry.nextFrameAt ??= now + entry.intervalMs;
			if (now < entry.nextFrameAt) continue;
			entry.frame++;
			entry.nextFrameAt = now + entry.intervalMs;
			entry.onFrame(entry.frame);
		}
	}

	private nextFrameAt(now: number): number | undefined {
		let next: number | undefined;
		for (const entry of this.entries.values()) {
			const candidate = entry.nextFrameAt ?? now + entry.intervalMs;
			next = next === undefined ? candidate : Math.min(next, candidate);
		}
		return next;
	}
}
