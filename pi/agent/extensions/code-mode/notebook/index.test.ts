import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestedToolResult, ToolCatalogEntry } from "../nested-dispatch.ts";
import type { HostBridge, HostToolCall } from "../rust-kernel.ts";
import { NotebookCellKernel, notebookCellSource } from "./index.ts";

// Echoes the cell source back as stream output. It proves the framing the kernel sends, without ZMQ.
const ECHO_HOST = `
const PREFIX = 4;
function write(message) {
	const payload = Buffer.from(JSON.stringify(message));
	const frame = Buffer.allocUnsafe(payload.length + PREFIX);
	frame.writeUInt32LE(payload.length, 0);
	payload.copy(frame, PREFIX);
	process.stdout.write(frame);
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
		if (request.type === "start") write({ type: "ready", id: request.id, kernelInfo: {} });
		if (request.type === "execute") {
			setTimeout(() => {
				write({ type: "output", id: request.id, output: { kind: "stream", name: "stdout", text: request.code } });
				write({ type: "done", id: request.id });
			}, 10);
		}
		if (request.type === "shutdown") { write({ type: "done", id: request.id }); setTimeout(() => process.exit(0), 5); }
	}
});
`;

const directory = mkdtempSync(join(tmpdir(), "pi-notebook-kernel-"));
const echoHost = join(directory, "echo-host.mjs");
writeFileSync(echoHost, ECHO_HOST);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const CATALOG: ToolCatalogEntry[] = [{ name: "read", description: "Read a file", input: "path: string" }];

function recordingBridge(): { bridge: HostBridge; calls: HostToolCall[]; notices: string[] } {
	const calls: HostToolCall[] = [];
	const notices: string[] = [];
	const bridge: HostBridge = {
		callTool: (call): Promise<NestedToolResult> => {
			calls.push(call);
			return Promise.resolve({ text: "ok" });
		},
		notify: (text) => notices.push(text),
	};
	return { bridge, calls, notices };
}

function echoKernel(): NotebookCellKernel {
	return new NotebookCellKernel(recordingBridge().bridge, { denoPath: "/bin/false", hostScript: echoHost });
}

it("frames a cell with begin and flush at the top level", () => {
	const source = notebookCellSource("cell-7", "const answer = 42;", CATALOG);
	expect(source.split("\n")).toEqual([
		'await globalThis.__pi_runtime.begin("cell-7", [{"name":"read","description":"Read a file"}], {"read":{"name":"read"}});',
		"const answer = 42;",
		'await globalThis.__pi_runtime.flush("cell-7");',
		"undefined;",
	]);
});

it("expands a raw block literal before the kernel sees it", () => {
	const source = notebookCellSource("cell-1", "const patch = @`\nhello\n`@;", []);
	expect(source).toContain('const patch = "hello\\n"');
});

it("runs a cell through the host and reports its output", async () => {
	const kernel = echoKernel();
	try {
		const outcome = await kernel.execute(3, 'text("hi");', CATALOG);
		expect(outcome.output).toContain('await globalThis.__pi_runtime.begin("cell-3"');
		expect(outcome.output).toContain('text("hi");');
		expect(outcome.error).toBeUndefined();
	} finally {
		kernel.dispose();
	}
});

it("reports a cell as running only while it runs", async () => {
	const kernel = echoKernel();
	try {
		expect(kernel.running).toBe(false);
		const cell = kernel.execute(1, "1;", []);
		expect(kernel.running).toBe(true);
		await cell;
		expect(kernel.running).toBe(false);
	} finally {
		kernel.dispose();
	}
});

it("refuses a cell whose signal is already aborted", async () => {
	const kernel = echoKernel();
	try {
		await expect(kernel.execute(2, "1;", [], AbortSignal.abort())).rejects.toThrow("cell 2 interrupted");
	} finally {
		kernel.dispose();
	}
});

it("reuses one kernel across cells", async () => {
	const kernel = echoKernel();
	try {
		await kernel.execute(1, "first;", []);
		const second = await kernel.execute(2, "second;", []);
		expect(second.output).toContain("second;");
	} finally {
		kernel.dispose();
	}
});
