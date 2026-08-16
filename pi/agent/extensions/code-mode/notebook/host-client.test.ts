import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookHostClient, notebookHostScript } from "./host-client.ts";
import type { NotebookHostOutput } from "./host-protocol.ts";

// A stand-in for host/host.mjs. It speaks the same frames without ZMQ, a kernel, or Deno.
const FAKE_HOST = `
const PREFIX = 4;
function send(message) {
	const payload = Buffer.from(JSON.stringify(message));
	const frame = Buffer.allocUnsafe(payload.length + PREFIX);
	frame.writeUInt32LE(payload.length, 0);
	payload.copy(frame, PREFIX);
	return frame;
}
function write(message) {
	process.stdout.write(send(message));
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		if (buffer.length < PREFIX) return;
		const length = buffer.readUInt32LE(0);
		if (buffer.length - PREFIX < length) return;
		const request = JSON.parse(buffer.subarray(PREFIX, PREFIX + length).toString("utf8"));
		buffer = buffer.subarray(PREFIX + length);
		handle(request);
	}
});
function handle(request) {
	if (request.type === "start") {
		write({ type: "ready", id: request.id, kernelInfo: { bootstrapBytes: request.bootstrap.length, cwd: request.cwd, deno: request.deno } });
		return;
	}
	if (request.type === "execute") {
		if (request.code.includes("BOOM")) {
			write({ type: "error", id: request.id, message: "fake host refused the cell" });
			return;
		}
		if (request.code.includes("DIE")) {
			write({ type: "exit", code: 9, signal: null, stderr: "kernel died" });
			return;
		}
		if (request.code.includes("SPLIT")) {
			// One frame, two writes. The client must hold the partial frame until the rest lands.
			const frame = send({ type: "output", id: request.id, output: { kind: "stream", name: "stdout", text: "x".repeat(200000) } });
			process.stdout.write(frame.subarray(0, 7));
			setTimeout(() => {
				process.stdout.write(frame.subarray(7));
				write({ type: "done", id: request.id });
			}, 10);
			return;
		}
		const delay = request.code.includes("SLOW") ? 30 : 0;
		setTimeout(() => {
			write({ type: "output", id: request.id, output: { kind: "stream", name: "stdout", text: request.code } });
			write({ type: "output", id: request.id, output: { kind: "result", data: { "text/plain": "ok" } } });
			write({ type: "done", id: request.id });
		}, delay);
		return;
	}
	if (request.type === "interrupt" || request.type === "restart") {
		write({ type: request.type === "restart" ? "ready" : "done", id: request.id, kernelInfo: {} });
		return;
	}
	if (request.type === "shutdown") {
		write({ type: "done", id: request.id });
		setTimeout(() => process.exit(0), 5);
	}
}
`;

const directory = mkdtempSync(join(tmpdir(), "pi-notebook-host-client-"));
const fakeHost = join(directory, "fake-host.mjs");
writeFileSync(fakeHost, FAKE_HOST);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function started(): Promise<{ client: NotebookHostClient; info: Record<string, unknown> }> {
	const client = new NotebookHostClient({ script: fakeHost });
	return client.start("/bin/deno", "/tmp", "BOOTSTRAP").then((info) => ({ client, info }));
}

function collect(client: NotebookHostClient, code: string): Promise<NotebookHostOutput[]> {
	const outputs: NotebookHostOutput[] = [];
	return client.execute(code, (output) => outputs.push(output)).then(() => outputs);
}

it("ships the start request and resolves with kernel info", async () => {
	const { client, info } = await started();
	expect(info).toEqual({ bootstrapBytes: 9, cwd: "/tmp", deno: "/bin/deno" });
	expect(client.alive).toBe(true);
	client.dispose();
});

it("routes outputs to the request that asked for them", async () => {
	const { client } = await started();
	const [slow, quick] = await Promise.all([collect(client, "SLOW one"), collect(client, "two")]);
	expect(slow?.[0]).toEqual({ kind: "stream", name: "stdout", text: "SLOW one" });
	expect(quick?.[0]).toEqual({ kind: "stream", name: "stdout", text: "two" });
	expect(slow?.[1]).toEqual({ kind: "result", data: { "text/plain": "ok" } });
	client.dispose();
});

it("reassembles a frame split across two writes", async () => {
	const { client } = await started();
	const outputs = await collect(client, "SPLIT");
	expect(outputs).toHaveLength(1);
	expect(outputs[0]).toEqual({ kind: "stream", name: "stdout", text: "x".repeat(200_000) });
	client.dispose();
});

it("rejects the request the host reports an error for", async () => {
	const { client } = await started();
	await expect(collect(client, "BOOM")).rejects.toThrow("fake host refused the cell");
	// One failed cell does not kill the host.
	expect(client.alive).toBe(true);
	client.dispose();
});

it("rejects everything in flight when the kernel exits", async () => {
	const { client } = await started();
	const settled = await Promise.allSettled([collect(client, "SLOW one"), collect(client, "DIE")]);
	expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
	for (const result of settled) {
		expect(String((result as PromiseRejectedResult).reason)).toContain("Notebook kernel exited (9): kernel died");
	}
	expect(client.alive).toBe(false);
	await expect(collect(client, "later")).rejects.toThrow("Notebook kernel exited (9)");
});

it("rejects everything in flight when the host process dies", async () => {
	const { client } = await started();
	const running = collect(client, "SLOW one");
	client.dispose();
	await expect(running).rejects.toThrow("Notebook host was disposed");
	expect(client.alive).toBe(false);
});

it("shuts the host down and stays dead", async () => {
	const { client } = await started();
	await client.shutdown();
	expect(client.alive).toBe(false);
	await client.shutdown();
});

it("names the missing node executable", async () => {
	const client = new NotebookHostClient({ node: "pi-notebook-node-does-not-exist", script: fakeHost });
	await expect(client.start("/bin/deno", "/tmp", "")).rejects.toThrow(
		/needs "pi-notebook-node-does-not-exist" on PATH/,
	);
});

it("points at the real sidecar by default", () => {
	expect(notebookHostScript()).toEndWith("/code-mode/notebook/host/host.mjs");
});
