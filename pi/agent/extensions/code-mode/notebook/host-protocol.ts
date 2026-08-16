/**
 * Stdio protocol between the Bun extension and the Node notebook host.
 *
 * The host exists only because `zeromq@6.5.0` panics under Bun with
 * `unsupported uv function: uv_async_init`. It owns ZMQ, the Jupyter v5.3 wire codec, and the
 * `deno jupyter --kernel` process, and nothing else. Tools, cells, and persistence stay in the
 * extension.
 *
 * Framing matches `rust-kernel.ts`: a little-endian uint32 byte length, then that many bytes of
 * JSON.
 */

export const NOTEBOOK_HOST_FRAME_PREFIX_BYTES = 4;
export const NOTEBOOK_HOST_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** A Jupyter output, already decoded from its wire message but not yet mapped to a `CellOutcome`. */
export type NotebookHostOutput =
	| { kind: "stream"; name: "stdout" | "stderr"; text: string }
	| { kind: "result"; data: Record<string, string> }
	| { kind: "display"; data: Record<string, string> }
	| { kind: "error"; ename: string; evalue: string; traceback: string[] };

export type NotebookHostRequest =
	/** Start the kernel. Resolves once it answers `kernel_info_request`. */
	| { type: "start"; id: number; deno: string; cwd: string; bootstrap: string }
	/** Run one cell. Outputs stream back as `output` events keyed by the same id. */
	| { type: "execute"; id: number; code: string }
	/**
	 * Ask the kernel which names complete a prefix. This is the only way to see top-level `let` and
	 * `const`: they live in the global lexical scope, where `Object.getOwnPropertyNames(globalThis)`
	 * cannot reach them.
	 */
	| { type: "complete"; id: number; code: string; cursor: number }
	/** Ask the kernel to abandon the running cell. */
	| { type: "interrupt"; id: number }
	/** Replace the kernel process, losing all cell state. */
	| { type: "restart"; id: number }
	| { type: "shutdown"; id: number };

export type NotebookHostEvent =
	| { type: "ready"; id: number; kernelInfo: Record<string, unknown> }
	| { type: "output"; id: number; output: NotebookHostOutput }
	/** The cell reached `execution_state: "idle"`. No further output carries this id. */
	| { type: "done"; id: number }
	| { type: "completions"; id: number; matches: string[] }
	| { type: "error"; id: number; message: string }
	/** The kernel process exited on its own. Every in-flight request is dead. */
	| { type: "exit"; code: number | null; signal: string | null; stderr: string };

export function encodeNotebookFrame(message: NotebookHostRequest | NotebookHostEvent): Buffer {
	const payload = Buffer.from(JSON.stringify(message));
	if (payload.length > NOTEBOOK_HOST_MAX_FRAME_BYTES) {
		throw new Error(`Notebook host frame exceeds ${NOTEBOOK_HOST_MAX_FRAME_BYTES} bytes`);
	}
	const frame = Buffer.allocUnsafe(payload.length + NOTEBOOK_HOST_FRAME_PREFIX_BYTES);
	frame.writeUInt32LE(payload.length, 0);
	payload.copy(frame, NOTEBOOK_HOST_FRAME_PREFIX_BYTES);
	return frame;
}

/** Pulls whole frames off a growing buffer. Returns the messages and whatever bytes are left over. */
export function decodeNotebookFrames<T>(buffer: Buffer): { messages: T[]; rest: Buffer } {
	const messages: T[] = [];
	let offset = 0;
	while (buffer.length - offset >= NOTEBOOK_HOST_FRAME_PREFIX_BYTES) {
		const length = buffer.readUInt32LE(offset);
		if (length > NOTEBOOK_HOST_MAX_FRAME_BYTES) throw new Error("Notebook host frame length is out of range");
		const start = offset + NOTEBOOK_HOST_FRAME_PREFIX_BYTES;
		if (buffer.length - start < length) break;
		messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")) as T);
		offset = start + length;
	}
	return { messages, rest: buffer.subarray(offset) };
}
