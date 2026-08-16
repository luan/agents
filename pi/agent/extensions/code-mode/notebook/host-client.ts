/**
 * The extension's end of the Node notebook host.
 *
 * It spawns `node host/host.mjs`, frames stdio with host-protocol.ts, and correlates every reply by
 * request id. It solves the same problem rust-kernel.ts:294 solves for the Rust host, over a much
 * smaller protocol.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	decodeNotebookFrames,
	encodeNotebookFrame,
	type NotebookHostEvent,
	type NotebookHostOutput,
	type NotebookHostRequest,
} from "./host-protocol.ts";

const STDERR_KEEP_BYTES = 16 * 1024;

/** Absolute path of the sidecar. It ships beside this file. */
export function notebookHostScript(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "host", "host.mjs");
}

export interface NotebookHostOptions {
	/** Resolved from PATH by default. ZMQ panics under Bun, so the host must run under Node. */
	node?: string;
	script?: string;
	cwd?: string;
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class NotebookHostClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer: Buffer = Buffer.alloc(0);
	private stderr = "";
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly outputs = new Map<number, (output: NotebookHostOutput) => void>();
	private dead: Error | undefined;
	private readonly node: string;

	constructor(options: NotebookHostOptions = {}) {
		this.node = options.node ?? "node";
		const child = spawn(this.node, [options.script ?? notebookHostScript()], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			env: { ...process.env, NO_COLOR: "1" },
			...(options.cwd ? { cwd: options.cwd } : {}),
		}) as ChildProcessWithoutNullStreams;
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP_BYTES);
		});
		child.on("error", (error: NodeJS.ErrnoException) => this.stop(this.spawnError(error)));
		child.on("exit", (code, signal) => {
			if (this.child === child)
				this.stop(new Error(`Notebook host exited (${signal ?? code ?? "unknown"})${this.trailer()}`));
		});
	}

	/** False once the host or its kernel died. The session builds a new client instead of reusing one. */
	get alive(): boolean {
		return this.dead === undefined;
	}

	/** Starts the kernel and runs the bootstrap. Resolves with `kernel_info_reply` content. */
	async start(deno: string, cwd: string, bootstrap: string): Promise<Record<string, unknown>> {
		const value = await this.request((id) => ({ type: "start", id, deno, cwd, bootstrap }));
		return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	}

	/** Runs one cell. Every output carries the same id, so `onOutput` sees only this cell. */
	async execute(code: string, onOutput: (output: NotebookHostOutput) => void): Promise<void> {
		await this.request((id) => ({ type: "execute", id, code }), onOutput);
	}

	/**
	 * Names the kernel offers for a prefix. `liveBindings` needs this: top-level `let` and `const`
	 * live in the global lexical scope, which `Object.getOwnPropertyNames(globalThis)` cannot see.
	 */
	async complete(code: string, cursor = code.length): Promise<string[]> {
		return (await this.request((id) => ({ type: "complete", id, code, cursor }))) as string[];
	}

	async interrupt(): Promise<void> {
		await this.request((id) => ({ type: "interrupt", id }));
	}

	/**
	 * Replaces the kernel process. Every cell binding is lost.
	 *
	 * The new kernel has no bootstrap: session.ts:68 passes an empty one to `start` and installs the
	 * bootstrap as a cell. Run `notebookBootstrapSource()` through `execute` again after a restart.
	 */
	async restart(): Promise<void> {
		await this.request((id) => ({ type: "restart", id }));
	}

	async shutdown(): Promise<void> {
		if (this.dead) return;
		try {
			await this.request((id) => ({ type: "shutdown", id }));
		} finally {
			this.dispose();
		}
	}

	dispose(): void {
		this.stop(new Error("Notebook host was disposed"));
	}

	private request(
		build: (id: number) => NotebookHostRequest,
		onOutput?: (output: NotebookHostOutput) => void,
	): Promise<unknown> {
		if (this.dead) return Promise.reject(this.dead);
		const id = this.nextId++;
		const settled = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
		if (onOutput) this.outputs.set(id, onOutput);
		const cleaned = settled.finally(() => {
			this.pending.delete(id);
			this.outputs.delete(id);
		});
		// `send` can pump the event loop, so the rejection can land before this returns. Observe it here.
		void cleaned.catch(() => undefined);
		try {
			this.send(build(id));
		} catch (error) {
			this.reject(id, error instanceof Error ? error : new Error(String(error)));
		}
		return cleaned;
	}

	private send(message: NotebookHostRequest): void {
		const child = this.child;
		if (!child) throw new Error("Notebook host is not running");
		// A failed spawn leaves stdin unwritable. The child's `error` event names the real reason, so
		// the request waits for that instead of reporting a useless write failure.
		if (!child.stdin.writable) return;
		child.stdin.write(encodeNotebookFrame(message));
	}

	private onData(chunk: Buffer): void {
		try {
			const { messages, rest } = decodeNotebookFrames<NotebookHostEvent>(Buffer.concat([this.buffer, chunk]));
			this.buffer = rest;
			for (const message of messages) this.onEvent(message);
		} catch (error) {
			this.stop(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private onEvent(event: NotebookHostEvent): void {
		switch (event.type) {
			case "ready":
				this.resolve(event.id, event.kernelInfo);
				return;
			case "output":
				this.outputs.get(event.id)?.(event.output);
				return;
			case "completions":
				this.resolve(event.id, event.matches);
				break;
			case "done":
				this.resolve(event.id, undefined);
				return;
			case "error":
				this.reject(event.id, new Error(event.message));
				return;
			case "exit": {
				const detail = event.stderr.trim();
				this.stop(
					new Error(
						`Notebook kernel exited (${event.signal ?? event.code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
					),
				);
				return;
			}
		}
	}

	private resolve(id: number, value: unknown): void {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		pending?.resolve(value);
	}

	private reject(id: number, error: Error): void {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		pending?.reject(error);
	}

	private stop(error: Error): void {
		if (this.dead) return;
		this.dead = error;
		const child = this.child;
		this.child = undefined;
		this.buffer = Buffer.alloc(0);
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.outputs.clear();
		if (child && !child.killed) child.kill();
	}

	private spawnError(error: NodeJS.ErrnoException): Error {
		if (error.code === "ENOENT") {
			return new Error(`Notebook Code Mode needs "${this.node}" on PATH: ${error.message}`);
		}
		return new Error(`Notebook host failed to start: ${error.message}${this.trailer()}`);
	}

	private trailer(): string {
		const detail = this.stderr.trim();
		return detail ? `: ${detail}` : "";
	}
}
