import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OneShotLspProcess } from "./lsp-process.ts";

// The fake stands in for `deno lsp`: same Content-Length framing, scripted misbehaviour by env.
const FAKE_SERVER = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const mode = process.env.PI_FAKE_LSP_MODE ?? "ok";
writeFileSync(process.env.PI_FAKE_LSP_PID, String(process.pid));
if (mode === "ignore-exit") process.on("SIGTERM", () => {});
let buffer = Buffer.alloc(0);
let configuration;
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end === -1) return;
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		handle(message);
	}
});
function send(value) {
	const body = JSON.stringify(value);
	process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(message) {
	if (message.method === undefined) {
		if (message.id === 900) configuration = message.result;
		return;
	}
	if (message.id === undefined) {
		if (message.method === "exit" && mode !== "ignore-exit") process.exit(0);
		return;
	}
	if (message.method === "initialize") {
		if (mode === "bad-length") return process.stdout.write("Content-Length: 99999999999999\\r\\n\\r\\n");
		if (mode === "no-header") return process.stdout.write("X-Nope: 1\\r\\n\\r\\n{}");
		if (mode === "rpc-error") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "boom" } });
		send({ jsonrpc: "2.0", id: 900, method: "workspace/configuration", params: { items: [{ section: "deno" }] } });
		return send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
	}
	if (message.method === "configurationSeen") return send({ jsonrpc: "2.0", id: message.id, result: configuration ?? null });
	send({ jsonrpc: "2.0", id: message.id, result: null });
}
`;

const root = mkdtempSync(join(tmpdir(), "pi-notebook-lsp-"));
const fake = join(root, "fake-lsp.mjs");
const pidFile = join(root, "pid");
writeFileSync(fake, FAKE_SERVER, { mode: 0o755 });
chmodSync(fake, 0o755);

function start(mode: string): OneShotLspProcess {
	process.env["PI_FAKE_LSP_MODE"] = mode;
	process.env["PI_FAKE_LSP_PID"] = pidFile;
	return new OneShotLspProcess({ deno: fake, cwd: root, signal: new AbortController().signal });
}

function alive(): boolean {
	try {
		process.kill(Number(readFileSync(pidFile, "utf8")), 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	delete process.env["PI_FAKE_LSP_MODE"];
});

it("completes a request and answers the server's configuration request", async () => {
	const lsp = start("ok");
	try {
		expect(await lsp.request("initialize", { processId: process.pid })).toEqual({ capabilities: {} });
		expect(await lsp.request("configurationSeen")).toEqual([{ enable: true }]);
	} finally {
		await lsp.shutdown();
	}
});

it("never stays resident, even when the process ignores exit and SIGTERM", async () => {
	const lsp = start("ignore-exit");
	await lsp.request("initialize", {});
	expect(alive()).toBe(true);
	await lsp.shutdown();
	expect(alive()).toBe(false);
});

it("rejects an out-of-range Content-Length and stops the process", async () => {
	const lsp = start("bad-length");
	await expect(lsp.request("initialize", {})).rejects.toThrow("invalid message length");
	await expect(lsp.request("initialize", {})).rejects.toThrow("Deno LSP is not running");
	await lsp.shutdown();
});

it("rejects a message without Content-Length", async () => {
	const lsp = start("no-header");
	await expect(lsp.request("initialize", {})).rejects.toThrow("without Content-Length");
	await lsp.shutdown();
});

it("surfaces a JSON-RPC error as a rejection and keeps the process usable", async () => {
	const lsp = start("rpc-error");
	try {
		await expect(lsp.request("initialize", {})).rejects.toThrow("Deno LSP request failed: boom");
		expect(await lsp.request("other")).toBeNull();
	} finally {
		await lsp.shutdown();
	}
});

it("rejects everything in flight when the signal aborts", async () => {
	process.env["PI_FAKE_LSP_MODE"] = "ok";
	process.env["PI_FAKE_LSP_PID"] = pidFile;
	const controller = new AbortController();
	const lsp = new OneShotLspProcess({ deno: fake, cwd: root, signal: controller.signal });
	const pending = lsp.request("slow");
	controller.abort(new Error("cell interrupted"));
	await expect(pending).rejects.toThrow("cell interrupted");
	await lsp.shutdown();
});

it("fails instead of hanging when the binary does not exist", async () => {
	const lsp = new OneShotLspProcess({
		deno: join(root, "absent"),
		cwd: root,
		signal: new AbortController().signal,
	});
	await expect(lsp.request("initialize", {})).rejects.toThrow("Deno LSP failed to start");
	await lsp.shutdown();
});
