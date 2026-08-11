import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHED_LAUNCH_TIMEOUT_MS, connect, runAttachedAgent } from "./attached-agent-runner";

function socketIn(dir: string): string {
	return join(dir, "control.sock");
}

test("attached agent startup honors cancellation before launching its terminal", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runAttachedAgent({} as never, "task", "work", "root", "agent", {
			signal: controller.signal,
		} as never),
	).rejects.toThrow();
});

test("launch waits past the old five second budget for a slow booting terminal", () => {
	// A pi CLI boot took 4.3-6.3s under load, so the launch budget must clear it with room.
	expect(ATTACHED_LAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
});

test("connect keeps waiting while the terminal is alive", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attached-connect-"));
	const path = socketIn(dir);
	const server = createServer(() => {});
	const timer = setTimeout(() => server.listen(path), 400);
	try {
		const socket = await connect(path, { timeoutMs: 5_000, probe: () => ({ tail: "" }) });
		socket.destroy();
	} finally {
		clearTimeout(timer);
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("connect fails as soon as the terminal exits, naming the exit code and output", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attached-connect-"));
	const started = Date.now();
	try {
		await expect(
			connect(socketIn(dir), {
				timeoutMs: 60_000,
				probe: () => ({ exitCode: 1, tail: "Cannot find module 'pi'" }),
			}),
		).rejects.toThrow(/exited \(code 1\)[\s\S]*Cannot find module 'pi'/);
		expect(Date.now() - started).toBeLessThan(2_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("connect reports the terminal output when the socket never appears", async () => {
	const dir = mkdtempSync(join(tmpdir(), "attached-connect-"));
	try {
		await expect(
			connect(socketIn(dir), { timeoutMs: 200, probe: () => ({ tail: "waiting for auth" }) }),
		).rejects.toThrow(/socket did not appear[\s\S]*waiting for auth/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
