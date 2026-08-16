// Node sidecar for Notebook Code Mode.
//
// It exists because `zeromq@6.5.0` panics under Bun with `unsupported uv function: uv_async_init`,
// and Pi extensions run under Bun. This process owns ZMQ, the Jupyter v5.3 wire codec, and the
// `deno jupyter --kernel` child. It knows nothing about tools, cells, or persistence.
//
// Protocol: see ../host-protocol.ts. Little-endian uint32 length, then that many bytes of JSON.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dealer, Subscriber } from "zeromq";

const DELIMITER = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
const PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const STDERR_KEEP_BYTES = 16 * 1024;

function send(message) {
	const payload = Buffer.from(JSON.stringify(message));
	const frame = Buffer.allocUnsafe(payload.length + PREFIX_BYTES);
	frame.writeUInt32LE(payload.length, 0);
	payload.copy(frame, PREFIX_BYTES);
	process.stdout.write(frame);
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function signature(parts, key) {
	const hmac = createHmac("sha256", key);
	for (const part of parts) hmac.update(part);
	return Buffer.from(hmac.digest("hex"));
}

function encodeMessage(type, content, session, key) {
	const header = {
		msg_id: randomUUID(),
		session,
		username: "pi",
		date: new Date().toISOString(),
		msg_type: type,
		version: PROTOCOL_VERSION,
	};
	const parts = [header, {}, {}, content].map((part) => Buffer.from(JSON.stringify(part)));
	return { msgId: header.msg_id, frames: [DELIMITER, signature(parts, key), ...parts] };
}

function decodeMessage(frames, key) {
	const at = frames.findIndex((frame) => frame.equals(DELIMITER));
	if (at < 0 || at + 5 >= frames.length) return undefined;
	const parts = frames.slice(at + 2, at + 6);
	const expected = signature(parts, key);
	const supplied = frames[at + 1];
	if (supplied.length !== expected.length || !supplied.equals(expected)) return undefined;
	try {
		return {
			header: JSON.parse(parts[0].toString()),
			parentHeader: JSON.parse(parts[1].toString()),
			content: JSON.parse(parts[3].toString()),
		};
	} catch {
		return undefined;
	}
}

/** `text/plain` from the kernel carries ANSI colour codes. */
function stripAnsi(value) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point.
	return value.replace(/\[[0-9;]*m/g, "");
}

function mimeBundle(data) {
	const bundle = {};
	for (const [mime, value] of Object.entries(data ?? {})) {
		if (typeof value === "string") bundle[mime] = mime === "text/plain" ? stripAnsi(value) : value;
		else bundle[mime] = JSON.stringify(value);
	}
	return bundle;
}

class Kernel {
	constructor() {
		this.child = undefined;
		this.shell = undefined;
		this.iopub = undefined;
		this.dir = undefined;
		this.key = undefined;
		this.session = undefined;
		this.stderr = "";
		/** msg_id of the execute_request -> the extension's request id. */
		this.pending = new Map();
		this.completions = new Map();
		this.iopubSeen = false;
		this.lastStart = undefined;
	}

	async start(deno, cwd, bootstrap) {
		this.lastStart = { deno, cwd, bootstrap };
		this.key = randomBytes(16).toString("hex");
		this.session = randomUUID();
		const ports = {
			shell: await freePort(),
			iopub: await freePort(),
			stdin: await freePort(),
			control: await freePort(),
			hb: await freePort(),
		};
		this.dir = mkdtempSync(join(tmpdir(), "pi-notebook-"));
		const connection = join(this.dir, "connection.json");
		writeFileSync(
			connection,
			JSON.stringify({
				transport: "tcp",
				ip: "127.0.0.1",
				signature_scheme: "hmac-sha256",
				key: this.key,
				shell_port: ports.shell,
				iopub_port: ports.iopub,
				stdin_port: ports.stdin,
				control_port: ports.control,
				hb_port: ports.hb,
			}),
		);

		this.child = spawn(deno, ["jupyter", "--kernel", "--conn", connection, "--quiet"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP_BYTES);
		});
		this.child.on("exit", (code, signal) => {
			const stderr = this.stderr.trim();
			for (const id of this.pending.values()) send({ type: "error", id, message: `Notebook kernel exited (${signal ?? code})` });
			this.pending.clear();
			send({ type: "exit", code, signal, stderr });
		});

		this.shell = new Dealer({ routingId: Buffer.from(this.session) });
		this.iopub = new Subscriber();
		this.shell.connect(`tcp://127.0.0.1:${ports.shell}`);
		this.iopub.connect(`tcp://127.0.0.1:${ports.iopub}`);
		this.iopub.subscribe("");
		void this.readOutputs();
		void this.readShell();

		const info = await this.handshake();
		// The bootstrap installs `tools`, the emitters, and store/load. A cell is useless without it.
		if (bootstrap) await this.executeSilently(bootstrap);
		return info;
	}

	/**
	 * `kernel_info_request` proves the shell DEALER is live. It does NOT prove iopub is: a ZMQ SUB
	 * drops everything published before its subscription lands, so a first cell sent too early loses
	 * its `status: idle` and never reports done. Every kernel_info also publishes busy/idle on iopub,
	 * so the loop repeats until a message actually arrives there.
	 */
	async handshake() {
		let info;
		for (let attempt = 0; attempt < 60; attempt++) {
			const { msgId, frames } = encodeMessage("kernel_info_request", {}, this.session, this.key);
			const reply = new Promise((resolve) => {
				this.pendingInfo = { msgId, resolve };
			});
			await this.shell.send(frames);
			info ??= await Promise.race([reply, new Promise((resolve) => setTimeout(() => resolve(undefined), 250))]);
			this.pendingInfo = undefined;
			if (info && this.iopubSeen) return info;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Notebook kernel did not bring up both the shell and iopub channels");
	}

	async readOutputs() {
		try {
			for await (const frames of this.iopub) {
				const message = decodeMessage(frames, this.key);
				if (!message) continue;
				this.iopubSeen = true;
				const id = this.pending.get(message.parentHeader?.msg_id);
				const type = message.header.msg_type;
				if (id === undefined) continue;
				if (type === "stream") {
					send({ type: "output", id, output: { kind: "stream", name: message.content.name === "stderr" ? "stderr" : "stdout", text: message.content.text ?? "" } });
				} else if (type === "execute_result") {
					send({ type: "output", id, output: { kind: "result", data: mimeBundle(message.content.data) } });
				} else if (type === "display_data" || type === "update_display_data") {
					send({ type: "output", id, output: { kind: "display", data: mimeBundle(message.content.data) } });
				} else if (type === "error") {
					send({
						type: "output",
						id,
						output: {
							kind: "error",
							ename: message.content.ename ?? "Error",
							evalue: stripAnsi(message.content.evalue ?? ""),
							traceback: (message.content.traceback ?? []).map(stripAnsi),
						},
					});
				} else if (type === "status" && message.content.execution_state === "idle") {
					this.pending.delete(message.parentHeader.msg_id);
					send({ type: "done", id });
				}
			}
		} catch {
			// The socket closes on shutdown. Nothing to report; `exit` already covers a real death.
		}
	}

	async readShell() {
		try {
			for await (const frames of this.shell) {
				const message = decodeMessage(frames, this.key);
				if (!message) continue;
				if (message.header.msg_type === "kernel_info_reply" && this.pendingInfo) {
					this.pendingInfo.resolve(message.content);
				}
				if (message.header.msg_type === "complete_reply") {
					const slot = this.completions.get(message.parentHeader?.msg_id);
					if (slot) {
						this.completions.delete(message.parentHeader.msg_id);
						slot(message.content.matches ?? []);
					}
				}
			}
		} catch {
			// closed
		}
	}

	async execute(id, code) {
		if (!this.shell) throw new Error("Notebook kernel is not running");
		const { msgId, frames } = encodeMessage(
			"execute_request",
			{ code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
			this.session,
			this.key,
		);
		this.pending.set(msgId, id);
		await this.shell.send(frames);
	}

	/** Top-level `let` and `const` are invisible to `getOwnPropertyNames`; `complete_request` sees them. */
	async complete(code, cursor) {
		const { msgId, frames } = encodeMessage("complete_request", { code, cursor_pos: cursor }, this.session, this.key);
		const matches = new Promise((resolve) => this.completions.set(msgId, resolve));
		await this.shell.send(frames);
		const result = await Promise.race([matches, new Promise((resolve) => setTimeout(() => resolve([]), 10_000))]);
		this.completions.delete(msgId);
		return result;
	}

	/** Runs code without reporting its output. Used for the bootstrap and for capture/restore. */
	async executeSilently(code) {
		const { msgId, frames } = encodeMessage(
			"execute_request",
			{ code, silent: true, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true },
			this.session,
			this.key,
		);
		const settled = new Promise((resolve) => {
			this.silent = { msgId, resolve };
		});
		await this.shell.send(frames);
		await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 30_000))]);
		this.silent = undefined;
	}

	dispose() {
		try {
			this.shell?.close();
			this.iopub?.close();
		} catch {
			// already closed
		}
		this.child?.kill();
		if (this.dir) rmSync(this.dir, { recursive: true, force: true });
	}
}

const kernel = new Kernel();
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		if (buffer.length < PREFIX_BYTES) return;
		const length = buffer.readUInt32LE(0);
		if (length > MAX_FRAME_BYTES) {
			send({ type: "exit", code: null, signal: null, stderr: "notebook host frame length out of range" });
			process.exit(1);
		}
		if (buffer.length - PREFIX_BYTES < length) return;
		const message = JSON.parse(buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + length).toString("utf8"));
		buffer = buffer.subarray(PREFIX_BYTES + length);
		void handle(message);
	}
});

async function handle(request) {
	try {
		if (request.type === "start") {
			const kernelInfo = await kernel.start(request.deno, request.cwd, request.bootstrap);
			send({ type: "ready", id: request.id, kernelInfo });
		} else if (request.type === "execute") {
			await kernel.execute(request.id, request.code);
		} else if (request.type === "complete") {
			send({ type: "completions", id: request.id, matches: await kernel.complete(request.code, request.cursor) });
		} else if (request.type === "interrupt") {
			kernel.child?.kill("SIGINT");
			send({ type: "done", id: request.id });
		} else if (request.type === "restart") {
			const { deno, cwd, bootstrap } = kernel.lastStart ?? {};
			kernel.dispose();
			await kernel.start(deno, cwd, bootstrap);
			send({ type: "ready", id: request.id, kernelInfo: {} });
		} else if (request.type === "shutdown") {
			kernel.dispose();
			send({ type: "done", id: request.id });
			process.exit(0);
		}
	} catch (error) {
		send({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
	}
}

process.on("SIGTERM", () => {
	kernel.dispose();
	process.exit(0);
});
