export interface SleepResult {
	elapsed_ms: number;
	reason: "elapsed" | "input" | "cancelled";
}

export function waitForInput(
	duration: number,
	waiters: Set<() => void>,
	pending: boolean,
	signal?: AbortSignal,
): Promise<SleepResult> {
	const started = Date.now();
	if (signal?.aborted) return Promise.resolve({ elapsed_ms: 0, reason: "cancelled" });
	return new Promise((resolve) => {
		const finish = (reason: SleepResult["reason"]) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			waiters.delete(wake);
			resolve({ elapsed_ms: Date.now() - started, reason });
		};
		const wake = () => finish("input"),
			cancel = () => finish("cancelled");
		const timer = setTimeout(() => finish("elapsed"), duration);
		waiters.add(wake);
		signal?.addEventListener("abort", cancel, { once: true });
		if (pending) wake();
	});
}
