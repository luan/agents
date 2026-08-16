import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecSessionManager } from "./exec-session-manager.ts";

const YIELD_MS = 5_000;

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsRunning(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return !processIsRunning(pid);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function checkDescendantCleanup(): Promise<void> {
	const sessions = createExecSessionManager({ minYieldTimeMs: 1 });
	const unrelated = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
	let descendantPid: number | undefined;
	try {
		const result = await sessions.exec(
			{ cmd: `sleep 60 & printf '%s' "$!"`, shell: "/bin/sh", login: false, yield_time_ms: YIELD_MS },
			process.cwd(),
		);
		descendantPid = Number(result.output);
		assert.equal(result.exit_code, 0);
		assert.ok(Number.isInteger(descendantPid));
		assert.equal(await waitForProcessExit(descendantPid), true);
		assert.equal(processIsRunning(unrelated.pid!), true);
	} finally {
		sessions.shutdown();
		if (descendantPid && processIsRunning(descendantPid)) process.kill(descendantPid, "SIGKILL");
		unrelated.kill("SIGKILL");
	}
}

async function checkNonColorEnvironment(): Promise<void> {
	const sessions = createExecSessionManager({ minYieldTimeMs: 1 });
	try {
		const result = await sessions.exec(
			{
				cmd: '[ -z "$FORCE_COLOR" ] && fc=unset || fc="$FORCE_COLOR"; printf "%s|%s|%s" "$NO_COLOR" "$TERM" "$fc"',
				shell: "/bin/sh",
				login: false,
				yield_time_ms: YIELD_MS,
			},
			process.cwd(),
		);
		assert.equal(result.output, "1|dumb|unset");
		assert.equal(result.exit_code, 0);
	} finally {
		sessions.shutdown();
	}
}

async function checkPolling(): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "exec-command-gate-"));
	const gate = join(directory, "gate");
	execFileSync("mkfifo", [gate]);
	const sessions = createExecSessionManager({ minYieldTimeMs: 1, minEmptyWriteYieldTimeMs: 1 });
	try {
		const first = await sessions.exec(
			{
				cmd: `cat ${shellQuote(gate)} >/dev/null; printf done`,
				shell: "/bin/sh",
				login: false,
				yield_time_ms: 250,
			},
			process.cwd(),
		);
		assert.ok(first.process_id);
		writeFileSync(gate, "release\n");

		let output = "";
		let exitCode: number | undefined;
		const deadline = Date.now() + 30_000;
		while (exitCode === undefined && Date.now() < deadline) {
			const next = await sessions.write({ process_id: first.process_id, chars: "", yield_time_ms: YIELD_MS });
			output += next.output;
			exitCode = next.exit_code;
		}
		assert.match(output, /done/);
		assert.equal(exitCode, 0);
	} finally {
		sessions.shutdown();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	await checkDescendantCleanup();
	await checkNonColorEnvironment();
	await checkPolling();
	console.log("exec session manager process checks passed");
}

void main();
