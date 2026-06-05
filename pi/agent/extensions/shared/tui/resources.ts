export type ResourceState<T> =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; data: T; updatedAt: number }
	| { kind: "stale"; data: T; updatedAt: number }
	| { kind: "error"; error: unknown; previous?: T; updatedAt?: number };

export interface ResourceController<T> {
	readonly state: ResourceState<T>;
	refresh(): Promise<void>;
	cancel(): void;
}

export function createResource<T>(options: { load(args: { signal: AbortSignal }): Promise<T> }): ResourceController<T> {
	return new ResourceControllerImpl(options.load);
}

class ResourceControllerImpl<T> implements ResourceController<T> {
	private currentState: ResourceState<T> = { kind: "idle" };
	private abortController: AbortController | undefined;

	constructor(private readonly load: (args: { signal: AbortSignal }) => Promise<T>) {}

	get state(): ResourceState<T> {
		return this.currentState;
	}

	async refresh(): Promise<void> {
		this.abortController?.abort();
		this.abortController = new AbortController();
		const previous =
			this.currentState.kind === "ready" || this.currentState.kind === "stale" ? this.currentState : undefined;
		this.currentState = previous
			? { kind: "stale", data: previous.data, updatedAt: previous.updatedAt }
			: { kind: "loading" };
		try {
			const data = await this.load({ signal: this.abortController.signal });
			if (this.abortController.signal.aborted) return;
			this.currentState = { kind: "ready", data, updatedAt: Date.now() };
		} catch (error) {
			if (this.abortController.signal.aborted) return;
			this.currentState = previous
				? { kind: "error", error, previous: previous.data, updatedAt: previous.updatedAt }
				: { kind: "error", error };
		}
	}

	cancel(): void {
		this.abortController?.abort();
	}
}
