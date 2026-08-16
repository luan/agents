import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createIsolatedNodePtyBackend } from "./isolated-node-pty-backend.ts";
import type { PtyProcess } from "./pty-backend.ts";

const HOST_PATH = fileURLToPath(new URL("../tools/node-pty-host.mjs", import.meta.url));

function exitOf(processHandle: PtyProcess): Promise<{ exitCode: number; sessionError?: string }> {
	return new Promise((resolve) => processHandle.onExit(resolve));
}

async function hostEvents(input: unknown): Promise<{ events: any[]; exitCode: number; stderr: string }> {
	const host = spawn("node", [HOST_PATH], {
		env: { PATH: process.env.PATH, TERM: "xterm-256color" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	host.stdout.setEncoding("utf8");
	host.stderr.setEncoding("utf8");
	host.stdout.on("data", (data) => (stdout += data));
	host.stderr.on("data", (data) => (stderr += data));
	host.stdin.write(`${typeof input === "string" ? input : JSON.stringify(input)}\n`);
	const exitCode = await new Promise<number>((resolve) => host.once("close", (code) => resolve(code ?? 1)));
	return {
		events: stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
		exitCode,
		stderr,
	};
}

async function checkHostLifecycle(): Promise<void> {
	const result = await hostEvents({
		type: "spawn",
		file: "/bin/sh",
		args: ["-c", "printf first; printf second; exit 7"],
		cwd: "/tmp",
		env: { PATH: process.env.PATH, TERM: "xterm-256color" },
		name: "xterm-256color",
		cols: 91,
		rows: 37,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stderr, "");
	assert.equal(result.events[0].type, "ready");
	assert.ok(result.events[0].pid > 0);
	assert.equal(result.events.at(-1)?.type, "exit");
	assert.equal(result.events.at(-1)?.exitCode, 7);
	assert.equal(
		result.events
			.filter((event) => event.type === "output")
			.map((event) => event.data)
			.join(""),
		"firstsecond",
	);
}

async function checkMalformedMessage(): Promise<void> {
	const result = await hostEvents("not-json");
	assert.equal(result.exitCode, 1);
	assert.equal(result.events[0]?.type, "error");
	assert.match(result.events[0]?.message, /JSON/);
}

async function checkAdapterInputResizeAndBuffering(): Promise<void> {
	const processHandle = await createIsolatedNodePtyBackend().spawn(
		"/bin/sh",
		["-c", 'IFS= read -r line; stty size; printf "input:%s" "$line"; exit 3'],
		{
			cwd: "/tmp",
			env: { ...process.env, TERM: "xterm-256color" },
			name: "xterm-256color",
			cols: 80,
			rows: 24,
		},
	);
	await processHandle.resize(101, 43);
	await processHandle.write("hello\n");
	await new Promise((resolve) => setTimeout(resolve, 100));
	let output = "";
	processHandle.onData((data) => (output += data));
	const exit = await exitOf(processHandle);
	assert.equal(exit.exitCode, 3);
	assert.equal(exit.sessionError, undefined);
	assert.match(output, /43 101/);
	assert.match(output, /input:hello/);
}

async function checkTermination(): Promise<void> {
	const processHandle = await createIsolatedNodePtyBackend({ forceKillDelayMs: 30 }).spawn(
		"/bin/sh",
		["-c", "trap '' TERM; while :; do sleep 1; done"],
		{
			cwd: "/tmp",
			env: { ...process.env, TERM: "xterm-256color" },
			name: "xterm-256color",
			cols: 80,
			rows: 24,
		},
	);
	processHandle.kill();
	const exit = await Promise.race([
		exitOf(processHandle),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("termination did not stop the PTY")), 2_000)),
	]);
	assert.notEqual(exit.exitCode, 0);
}

async function checkUnexpectedHostExit(): Promise<void> {
	const crashHost = `/tmp/pi-pty-crash-host-${process.pid}.mjs`;
	await writeFile(
		crashHost,
		'process.stdin.resume(); process.stdout.write(JSON.stringify({type:"ready",pid:123})+"\\n",()=>process.exit(9));',
	);
	try {
		const processHandle = await createIsolatedNodePtyBackend({ hostPath: crashHost }).spawn("/bin/true", [], {
			cwd: "/tmp",
			env: { ...process.env },
			name: "xterm-256color",
			cols: 80,
			rows: 24,
		});
		const exit = await exitOf(processHandle);
		assert.equal(exit.exitCode, 9);
		assert.match(exit.sessionError ?? "", /exited unexpectedly/);
	} finally {
		await unlink(crashHost).catch(() => undefined);
	}
}

await checkHostLifecycle();
await checkMalformedMessage();
await checkAdapterInputResizeAndBuffering();
await checkTermination();
await checkUnexpectedHostExit();
console.log("isolated PTY transport checks passed");
