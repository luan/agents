import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";

const nodePtyDir = dirname(dirname(fileURLToPath(import.meta.resolve("node-pty"))));
chmodSync(join(nodePtyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), 0o755);

let child;
let failing = false;
let ready = false;
const pendingEvents = [];

function send(message, callback) {
	process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function fail(error) {
	if (failing) return;
	failing = true;
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	try {
		killChild("SIGKILL");
	} catch {}
	send({ type: "error", message }, () => process.exit(1));
}

function sendChildEvent(message, callback) {
	if (ready) send(message, callback);
	else pendingEvents.push({ message, callback });
}

function killChild(signal) {
	if (!child) return;
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {}
	}
	child.kill(signal);
}

function flushPendingEvents() {
	ready = true;
	for (const event of pendingEvents.splice(0)) send(event.message, event.callback);
}

function spawnChild(request) {
	if (child) throw new Error("the PTY process already exists");
	child = pty.spawn(request.file, request.args, {
		cwd: request.cwd,
		env: request.env,
		name: request.name,
		cols: request.cols,
		rows: request.rows,
	});
	child.onData((data) => sendChildEvent({ type: "output", data }));
	child.onExit(({ exitCode }) => {
		if (failing) return;
		sendChildEvent({ type: "exit", exitCode }, () => process.exit(0));
	});
	send({ type: "ready", pid: child.pid }, flushPendingEvents);
}

function receive(message) {
	if (!child) {
		if (message.type !== "spawn") throw new Error(`expected spawn, received ${String(message.type)}`);
		spawnChild(message);
		return;
	}
	if (message.type === "input") {
		if (typeof message.data !== "string") throw new Error("input data must be a string");
		child.write(message.data);
		return;
	}
	if (message.type === "resize") {
		if (!Number.isInteger(message.cols) || message.cols < 1 || !Number.isInteger(message.rows) || message.rows < 1) {
			throw new Error("resize columns and rows must be positive integers");
		}
		child.resize(message.cols, message.rows);
		return;
	}
	if (message.type === "terminate") {
		killChild(message.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
		return;
	}
	throw new Error(`unknown command ${String(message.type)}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.length === 0) return;
	try {
		receive(JSON.parse(line));
	} catch (error) {
		fail(error);
	}
});

process.stdin.on("end", () => {
	if (!child) fail(new Error("stdin closed before spawn"));
	else killChild("SIGHUP");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => killChild(signal));
}
