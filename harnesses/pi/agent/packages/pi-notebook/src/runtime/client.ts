import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureNativeBinary } from "@luan.sh/pi-libtui";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function parseReply(text: string): JsonValue {
	// type-boundary: serde_json emits JSON values; validate the version and response envelope immediately.
	const value = JSON.parse(text) as JsonValue;
	if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("ok" in value))
		throw new Error("Invalid notebook response");
	if (value.ok === false && "error" in value && typeof value.error === "string") throw new Error(value.error);
	if (value.ok !== true || !("result" in value)) throw new Error("Invalid notebook response");
	return value.result;
}
const MAX_FRAME = 16 * 1024 * 1024;
export class NotebookClient {
	private child?: ChildProcessWithoutNullStreams;
	private identity?: string;
	private starting?: Promise<void>;
	private closing?: Promise<void>;
	private generation = 0;
	private pending?: { resolve(value: JsonValue): void; reject(error: Error): void };
	private buffer = Buffer.alloc(0);
	private stderr = "";
	private busy = false;
	async execute(request: JsonValue, ctx: ExtensionContext, signal?: AbortSignal): Promise<JsonValue> {
		if (this.busy) throw new Error("Notebook is busy; wait for the active cell before starting another operation");
		this.busy = true;
		const abort = () => this.stop(new Error("Notebook interrupted; the last completed checkpoint is retained"));
		try {
			signal?.throwIfAborted();
			signal?.addEventListener("abort", abort, { once: true });
			await this.start(ctx);
			if (signal?.aborted) {
				abort();
				signal.throwIfAborted();
			}
			const data = Buffer.from(JSON.stringify(request));
			if (data.length > MAX_FRAME) throw new Error("Notebook request exceeds 16 MiB");
			const header = Buffer.alloc(4);
			header.writeUInt32LE(data.length);
			return await new Promise<JsonValue>((resolve, reject) => {
				this.pending = { resolve, reject };
				this.child!.stdin.write(Buffer.concat([header, data]), (error) => {
					if (error) this.stop(error);
				});
			});
		} finally {
			signal?.removeEventListener("abort", abort);
			this.busy = false;
		}
	}
	private async start(ctx: ExtensionContext): Promise<void> {
		const identity = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
		if (this.identity !== identity) this.stop();
		if (this.child) return;
		if (this.starting) return this.starting;
		const generation = this.generation;
		this.starting = (async () => {
			await this.closing;
			const binary = await ensureNativeBinary(
				{ crate: "notebook-host", binaryName: "notebook-host", env: "PI_NOTEBOOK_HOST_BINARY" },
				{ onBuild: (text) => ctx.ui.notify(text, "info") },
			);
			if (generation !== this.generation) throw new Error("Notebook startup cancelled");
			const root = join(getAgentDir(), "cache", "pi-notebook");
			const project = createHash("sha256").update(ctx.cwd).digest("hex");
			const session = createHash("sha256").update(identity).digest("hex");
			const child = spawn(binary, [root, ctx.cwd, join(root, "sessions", session), join(root, "profiles", project)], {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});
			this.child = child;
			this.identity = identity;
			this.buffer = Buffer.alloc(0);
			this.stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				if (this.child !== child) return;
				this.buffer = Buffer.concat([this.buffer, chunk]);
				if (this.buffer.length < 4) return;
				const size = this.buffer.readUInt32LE();
				if (size > MAX_FRAME || this.buffer.length > MAX_FRAME + 4) {
					this.stop(new Error("Notebook response exceeds 16 MiB"));
					return;
				}
				if (this.buffer.length < size + 4) return;
				const payload = this.buffer.subarray(4, size + 4);
				this.buffer = this.buffer.subarray(size + 4);
				const pending = this.pending;
				this.pending = undefined;
				try {
					pending?.resolve(parseReply(payload.toString()));
				} catch (error) {
					pending?.reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (this.child === child) this.stderr = (this.stderr + chunk.toString()).slice(-4096);
			});
			child.on("error", (error) => {
				if (this.child === child) this.stop(error);
			});
			child.on("close", (code) => {
				if (this.child === child) this.stop(new Error(`Notebook host exited (${code}): ${this.stderr}`));
			});
		})().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}
	stop(error = new Error("Notebook closed")): void {
		this.generation++;
		this.pending?.reject(error);
		this.pending = undefined;
		const child = this.child;
		this.child = undefined;
		this.identity = undefined;
		// EOF cancels the Rust host and drops the child kernel, including an active cell.
		if (child && child.exitCode === null && child.signalCode === null) {
			this.closing = new Promise<void>((resolve) => child.once("close", () => resolve()));
			child.stdin.end();
		}
	}
}
