import { expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import type { TerminalBridgeClient } from "../src/terminal/bridge-client.ts";
import { createPtyHost } from "../src/terminal/pty-host.ts";
import { PtyPane, PtyProcess } from "../src/terminal/pty-pane.ts";

test("runs an interactive PTY at its rendered size without redundant work or frames", async () => {
	const requests: Record<string, unknown>[] = [];
	let finishRead: ((response: unknown) => void) | undefined;
	const bridge: TerminalBridgeClient = {
		request: <T>(request: Record<string, unknown>) => {
			requests.push(request);
			if (request.op === "read")
				return new Promise<T>((resolve) => {
					finishRead = resolve as (response: unknown) => void;
				});
			if (request.op === "write") return Promise.resolve({ status: "accepted" } as T);
			return Promise.resolve({} as T);
		},
		shutdown: async () => {},
	};
	const host = createPtyHost({ bridge, createProcessId: () => "process-1", environment: {} });
	const scope = Object.create(null) as typeof globalThis;
	Reflect.set(scope, Symbol.for("pi-libtui/pty-host/v2"), host);
	const process = new PtyProcess({
		label: "test",
		command: "pi",
		context: { cwd: "/tmp", ui: { notify() {} } } as never,
		onExit() {},
		scope,
	});

	process.render(120, 40, false);
	await Promise.resolve();
	expect(requests.find((request) => request.op === "exec")).toMatchObject({ rows: 40, cols: 120 });
	process.render(100, 30, false);
	process.render(110, 35, false);
	for (const data of "abc") process.sendInput(data);
	await Bun.sleep(0);
	expect(requests.filter((request) => request.op === "resize" || request.op === "write")).toEqual([
		{ op: "resize", process_id: "process-1", rows: 35, cols: 110 },
		{ op: "write", process_id: "process-1", chunk: "abc" },
	]);

	let immediateRenders = 0;
	const tui = {
		requestImmediateRender: () => (immediateRenders += 1),
	} as never as TUI;
	const pane = new PtyPane(process, { tui, rows: () => 35, requestRender() {} });
	finishRead?.({
		chunks: [{ seq: 1, stream: "pty", chunk: Buffer.from("abc").toString("base64") }],
		nextSeq: 2,
		exited: false,
		closed: false,
	});
	await Bun.sleep(0);
	expect(immediateRenders).toBe(1);

	pane.dispose();
	process.dispose();
	await host.shutdown();
});
