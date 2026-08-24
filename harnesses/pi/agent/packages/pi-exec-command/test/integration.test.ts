import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecCommandBinary } from "../src/binary.ts";
import { createExecSessionManager } from "../src/session-manager.ts";
import { createExecCommandTool } from "../src/tools/exec-command/definition.ts";

function manager() {
	// These tests cover the native bridge protocol; session-manager.test.ts covers the public 250 ms wait bound.
	return createExecSessionManager({ binaryPath: resolveExecCommandBinary, maxExecYieldTimeMs: 50 });
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
			if (Number.isFinite(pid)) return pid;
		} catch {
			// The child has not created the file yet.
		}
		await Bun.sleep(5);
	}
	throw new Error("child pid was not written");
}

async function expectProcessGone(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			process.kill(pid, 0);
			await Bun.sleep(5);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
	}
	throw new Error(`process ${pid} survived termination`);
}

test("the registered tool runs a real pipe command and reports its presentation transition", async () => {
	const sessions = manager();
	try {
		const tool = createExecCommandTool({ getManager: () => sessions });
		const updates: unknown[] = [];
		const result = await tool.execute(
			"integration",
			{
				cmd: "printf stdout; printf stderr >&2",
				shell: "/bin/sh",
				login: false,
				yield_time_ms: 5_000,
			},
			undefined,
			(update) => updates.push(update),
			{
				cwd: process.cwd(),
				isProjectTrusted: () => true,
			} as never,
		);
		expect(updates.length).toBeGreaterThan(1);
		expect((updates[0] as { details: { phase: string } }).details.phase).toBe("partial");
		expect(
			updates.some((update) =>
				(update as { details: { progress: { output: string } } }).details.progress.output.includes("stdout"),
			),
		).toBe(true);
		expect(result.details.phase).toBe("final");
		expect(result.details.outcome).toEqual({ status: "succeeded", exitCode: 0, failure: null });
		expect(result.details.progress.output).toContain("stdout");
		expect(result.details.progress.output).toContain("stderr");
		expect(result.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("stdout") }));
	} finally {
		await sessions.shutdown();
	}
});

test("the release bridge accepts TTY input", async () => {
	const sessions = manager();
	try {
		const running = await sessions.exec(
			{
				cmd: "read value; printf got:$value",
				shell: "/bin/sh",
				login: false,
				tty: true,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		expect(running.session_id).toBeNumber();
		const completed = await sessions.write({
			session_id: running.session_id!,
			chars: "hello\n",
			yield_time_ms: 5_000,
		});
		expect(completed.exit_code).toBe(0);
		expect(completed.output).toContain("got:hello");
	} finally {
		await sessions.shutdown();
	}
});

test("a non-TTY session rejects input", async () => {
	const sessions = manager();
	try {
		const running = await sessions.exec(
			{
				cmd: "sleep 5",
				shell: "/bin/sh",
				login: false,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		await expect(sessions.write({ session_id: running.session_id!, chars: "x" })).rejects.toThrow("stdin is closed");
	} finally {
		await sessions.shutdown();
	}
});

test("an aborted command terminates its process tree", async () => {
	const sessions = manager();
	const directory = await mkdtemp(join(tmpdir(), "pi-exec-tree-"));
	const pidPath = join(directory, "child.pid");
	const controller = new AbortController();
	const execution = sessions.exec(
		{
			cmd: `sleep 30 & echo $! > '${pidPath}'; wait`,
			shell: "/bin/sh",
			login: false,
			yield_time_ms: 5_000,
		},
		process.cwd(),
		controller.signal,
	);
	const pid = await waitForPid(pidPath);
	controller.abort();
	await expect(execution).rejects.toThrow("aborted");
	await expectProcessGone(pid);
	await sessions.shutdown();
});

test("shutdown terminates sessions and prevents further execution", async () => {
	const sessions = manager();
	const running = await sessions.exec(
		{
			cmd: "sleep 30",
			shell: "/bin/sh",
			login: false,
			yield_time_ms: 250,
		},
		process.cwd(),
	);
	expect(running.session_id).toBeNumber();
	await sessions.shutdown();
	await expect(sessions.exec({ cmd: "true" }, process.cwd())).rejects.toThrow("shut down");
});

test("completed session output remains available to repeated polls", async () => {
	const sessions = manager();
	try {
		const running = await sessions.exec(
			{
				cmd: "printf first; sleep 0.1; printf second",
				shell: "/bin/sh",
				login: false,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		expect(running.session_id).toBeNumber();
		const completed = await sessions.write({ session_id: running.session_id! });
		expect(completed.exit_code).toBe(0);
		const replay = await sessions.write({ session_id: running.session_id! });
		expect(replay.exit_code).toBe(0);
		expect(replay.output).toBe("firstsecond");
	} finally {
		await sessions.shutdown();
	}
});
