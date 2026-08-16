import { expect, it } from "bun:test";
import { CellSession, collect } from "./runtime.ts";

it("waits for sibling host calls after Promise.all rejects", async () => {
	let slowResolve: (() => void) | undefined;
	const slowStarted = new Promise<void>((resolve) => {
		slowResolve = resolve;
	});
	let releaseSlow: (() => void) | undefined;
	const slow = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	const session = new CellSession({
		callTool: async ({ name }: { name: string }) => {
			if (name === "fail") throw new Error("expected failure");
			slowResolve?.();
			await slow;
			return { text: "slow complete" };
		},
		notify: () => {},
	});
	const record = session.start({
		code: "await Promise.all([tools.fail({}), tools.slow({})])",
		language: "js",
		catalog: [
			{ name: "fail", description: "fail", input: "{}" },
			{ name: "slow", description: "slow", input: "{}" },
		],
	});
	let settled = false;
	void record.promise.then(() => {
		settled = true;
	});

	try {
		await slowStarted;
		await Bun.sleep(20);
		expect(settled).toBe(false);
		releaseSlow?.();
		const finished = await collect(record, 1_000);
		expect(finished.done).toBe(true);
		expect(record.calls.map(({ name, status }) => [name, status])).toEqual([
			["fail", "error"],
			["slow", "completed"],
		]);
	} finally {
		session.dispose();
	}
});

it("rejects a cell whose signal was already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const session = new CellSession({ callTool: async () => ({ text: "" }), notify: () => {} });
	try {
		const record = session.start({
			code: "globalThis.shouldNotRun = true",
			language: "js",
			catalog: [],
			signal: controller.signal,
		});
		const result = await collect(record, 1_000);
		expect(result.error?.message).toBe("cell 1 interrupted");
	} finally {
		session.dispose();
	}
});
