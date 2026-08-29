import { spawn } from "node:child_process";
import { expect, test } from "bun:test";
import { createTerminalBridgeClient, parseTerminalBridgeReadResponse } from "../src/terminal/bridge-client.ts";

test("rejects an invalid native response and replaces its bridge generation", async () => {
	let generation = 0;
	const bridge = createTerminalBridgeClient({
		binaryPath: () => process.execPath,
		spawnBridge: () => {
			generation += 1;
			const source =
				generation === 1
					? 'process.stdin.once("data", () => process.stdout.write("bad\\n")); setInterval(() => {}, 1000)'
					: 'process.stdin.once("data", data => { const r = JSON.parse(data); process.stdout.write(JSON.stringify({ request_id: r.request_id, ok: true, result: "replacement" }) + "\\n", () => process.exit(0)) })';
			return spawn(process.execPath, ["-e", source], { stdio: "pipe" });
		},
	});

	await expect(bridge.request({ op: "first" })).rejects.toThrow("invalid response");
	await expect(bridge.request({ op: "second" })).resolves.toBe("replacement");
	await bridge.shutdown();
});

test("rejects non-contiguous terminal read sequences", () => {
	const base = { exited: false, closed: false };
	const parse = (chunks: object[], nextSeq: number) => parseTerminalBridgeReadResponse({ ...base, chunks, nextSeq });
	expect(parse([{ startSeq: 1, seq: 3, stream: "pty", chunk: "YQ==" }], 4)).toBeDefined();
	expect(
		parse(
			[
				{ seq: 1, stream: "pty", chunk: "YQ==" },
				{ seq: 3, stream: "pty", chunk: "Yg==" },
			],
			4,
		),
	).toBeUndefined();
	expect(parse([{ seq: 1, stream: "pty", chunk: "not base64" }], 2)).toBeUndefined();
	expect(parseTerminalBridgeReadResponse({ ...base, chunks: [], nextSeq: 2 }, 1)).toBeUndefined();
	expect(
		parseTerminalBridgeReadResponse({ ...base, chunks: [{ seq: 2, stream: "pty", chunk: "YQ==" }], nextSeq: 3 }, 1),
	).toBeUndefined();
});
