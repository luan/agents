import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { workspaceBinary } from "../shared/workspace.ts";
import type { NestedToolResult, ToolCatalogEntry } from "./nested-dispatch.ts";
import { preprocessRawBlockLiterals } from "./payload.ts";

// Types the host and the Rust cell kernel share. The Rust host is the only cell runtime.
export interface HostToolCall {
	cellId?: number;
	name: string;
	args: unknown;
	maxTokens?: number;
	signal?: AbortSignal;
	// Filled in by `CellSession` so the row and the execution share one id. fileops' latest-turn gate keys on it.
	toolCallId?: string;
}

export interface HostBridge {
	callTool(call: HostToolCall): Promise<NestedToolResult>;
	// Nothing is sent back, unlike every other message a cell sends: the deadline stays running and the cell does not wait.
	notify(text: string, cellId: number | undefined): void;
}

export interface CellImage {
	data: string;
	mimeType: string;
}

export interface CellOutcome {
	output: string;
	images?: CellImage[];
	error?: string;
}

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_RUST_TRANSPILE_BYTES = 128 * 1024;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type RustCell = {
	cellId: string;
	signal?: AbortSignal;
	resolve: (outcome: CellOutcome) => void;
	reject: (error: Error) => void;
};

export function defaultRustHostBinary(): string {
	return process.env.PI_CODE_MODE_RUST_HOST ?? workspaceBinary("codex-code-mode-host");
}

export function rustSource(source: string): string {
	const raw = preprocessRawBlockLiterals(source);
	if (Buffer.byteLength(raw, "utf8") > MAX_RUST_TRANSPILE_BYTES) return raw;
	try {
		const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
		return transpiler.transformSync(raw);
	} catch {
		return raw;
	}
}

declare const Bun: {
	Transpiler: new (options: { loader: string; target: string }) => { transformSync(code: string): string };
};

export class RustCellKernel {
	private child: ChildProcessWithoutNullStreams | undefined;
	private buffer = Buffer.alloc(0);
	private stderr = "";
	private nextRequestId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly initial = new Map<number, Pending>();
	private readonly cells = new Map<number, RustCell>();
	private readonly delegateAbort = new Map<number, AbortController>();
	private startPromise: Promise<void> | undefined;
	private readonly waiting = new Set<number>();
	private sessionId = randomUUID();

	constructor(
		private readonly binary = defaultRustHostBinary(),
		private readonly bridge: HostBridge,
	) {}

	get running(): boolean {
		return this.cells.size > 0;
	}

	wait(localId: number, yieldTimeMs: number): void {
		const cell = this.cells.get(localId);
		if (!cell || this.waiting.has(localId)) return;
		this.waiting.add(localId);
		void this.request({
			method: "session/wait",
			sessionId: this.sessionId,
			request: { cell_id: cell.cellId, yield_time_ms: yieldTimeMs },
		}).then(
			(value) => {
				this.waiting.delete(localId);
				this.consumeWait(localId, value);
			},
			(error) => {
				this.waiting.delete(localId);
				this.failCell(localId, error instanceof Error ? error : new Error(String(error)));
			},
		);
	}

	reset(): void {
		this.sessionId = randomUUID();
		this.stop(new Error("Rust kernel reset"));
	}

	async run(
		localId: number,
		source: string,
		catalog: ToolCatalogEntry[],
		signal?: AbortSignal,
		yieldTimeMs = 30_000,
	): Promise<CellOutcome> {
		if (signal?.aborted) throw new Error(`cell ${localId} interrupted`);
		await this.start();
		const requestId = this.nextRequestId++;
		const initial = this.expectInitial(requestId);
		// The operation can fail before execution reaches `await initial`; keep that sibling rejection observed.
		void initial.catch(() => undefined);
		const operation = this.expectOperation(requestId);
		let activeCellId: string | undefined;
		const onAbort = () => {
			if (activeCellId) {
				void this.request({
					method: "session/terminate",
					sessionId: this.sessionId,
					cellId: activeCellId,
				}).catch(() => undefined);
			} else {
				this.send({ type: "operation/cancel", id: requestId });
			}
			const error = new Error(`cell ${localId} interrupted`);
			this.rejectRequest(requestId, error);
			this.failCell(localId, error);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			this.send({
				type: "operation/request",
				id: requestId,
				request: {
					method: "session/execute",
					sessionId: this.sessionId,
					request: {
						tool_call_id: `cell-${localId}`,
						enabled_tools: catalog.map(wireTool),
						source: rustSource(source),
						yield_time_ms: yieldTimeMs,
						max_output_tokens: null,
					},
				},
			});
			const started = await operation;
			const cellId = executionCellId(started);
			if (!cellId) throw new Error("Rust Code Mode host returned no cell id");
			activeCellId = cellId;
			const cell: RustCell = {
				cellId,
				signal,
				resolve: () => {},
				reject: () => {},
			};
			const result = new Promise<CellOutcome>((resolve, reject) => {
				cell.resolve = resolve;
				cell.reject = reject;
			});
			void result.catch(() => undefined);
			this.cells.set(localId, cell);
			this.consumeInitial(localId, await initial);
			return await result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private consumeInitial(localId: number, value: unknown): void {
		const outcome = runtimeOutcome(value);
		if (!outcome) {
			this.failCell(localId, new Error("Rust Code Mode host returned an invalid runtime response"));
			return;
		}
		if (outcome.kind === "result") this.resolveCell(localId, outcome);
	}

	private consumeWait(localId: number, value: unknown): void {
		const waitOutcome = value && typeof value === "object" ? (value as { outcome?: unknown }).outcome : undefined;
		const response =
			waitOutcome && typeof waitOutcome === "object"
				? ((waitOutcome as Record<string, unknown>).LiveCell ??
					(waitOutcome as Record<string, unknown>).MissingCell)
				: undefined;
		const outcome = runtimeOutcome(response);
		if (!outcome) {
			this.failCell(localId, new Error("Rust Code Mode host returned an invalid wait outcome"));
			return;
		}
		if (outcome.kind === "result" || outcome.kind === "terminated") this.resolveCell(localId, outcome);
	}

	private resolveCell(localId: number, outcome: RustRuntimeOutcome): void {
		const cell = this.cells.get(localId);
		if (!cell) return;
		this.cells.delete(localId);
		cell.resolve(toCellOutcome(outcome));
	}

	private failCell(localId: number, error: Error): void {
		const cell = this.cells.get(localId);
		if (!cell) return;
		this.cells.delete(localId);
		cell.reject(error);
	}

	private async start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.open();
		try {
			await this.startPromise;
		} catch (error) {
			this.startPromise = undefined;
			this.stop(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private async open(): Promise<void> {
		const child = spawn(this.binary, [], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
			env: { ...process.env, NO_COLOR: "1" },
		}) as ChildProcessWithoutNullStreams;
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
		});
		child.on("error", (error) => this.stop(error));
		child.on("exit", (code, signal) => {
			if (this.child === child) {
				this.stop(
					new Error(
						`Rust Code Mode host exited (${signal ?? code ?? "unknown"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
					),
				);
			}
		});
		const handshake = this.expectOperation(0);
		this.send({
			type: "connection/hello",
			supportedVersions: [1],
			requiredCapabilities: [],
			optionalCapabilities: [],
		});
		await handshake;
		await this.request({ method: "session/open", sessionId: this.sessionId });
	}

	private expectOperation(id: number): Promise<unknown> {
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	private expectInitial(id: number): Promise<unknown> {
		return new Promise((resolve, reject) => this.initial.set(id, { resolve, reject }));
	}

	private request(request: unknown): Promise<unknown> {
		const id = this.nextRequestId++;
		const pending = this.expectOperation(id);
		this.send({ type: "operation/request", id, request });
		return pending;
	}

	private send(message: unknown): void {
		const child = this.child;
		if (!child?.stdin.writable) throw new Error("Rust Code Mode host is not running");
		const payload = Buffer.from(JSON.stringify(message));
		if (payload.length > MAX_FRAME_BYTES) throw new Error(`Rust Code Mode frame exceeds ${MAX_FRAME_BYTES} bytes`);
		const frame = Buffer.allocUnsafe(payload.length + 4);
		frame.writeUInt32LE(payload.length, 0);
		payload.copy(frame, 4);
		child.stdin.write(frame);
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32LE(0);
			if (length > MAX_FRAME_BYTES) {
				this.stop(new Error(`Rust Code Mode frame exceeds ${MAX_FRAME_BYTES} bytes`));
				return;
			}
			if (this.buffer.length < length + 4) return;
			const payload = this.buffer.subarray(4, length + 4);
			this.buffer = this.buffer.subarray(length + 4);
			try {
				this.onMessage(JSON.parse(payload.toString("utf8")));
			} catch (error) {
				this.stop(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	}

	private onMessage(message: unknown): void {
		if (!message || typeof message !== "object") throw new Error("Rust Code Mode host returned an invalid message");
		const value = message as Record<string, unknown>;
		const type = value.type;
		if (type === "connection/ready") {
			this.resolveRequest(0, value);
			return;
		}
		if (type === "connection/rejected") {
			this.rejectRequest(0, new Error(`Rust Code Mode handshake rejected: ${JSON.stringify(value.reason)}`));
			return;
		}
		if (type === "operation/response" || type === "execute/initialResponse") {
			const id = value.id;
			const result = value.result;
			if (!Number.isSafeInteger(id) || !result || typeof result !== "object")
				throw new Error("Rust Code Mode host returned an invalid operation response");
			const resultValue = result as Record<string, unknown>;
			if (resultValue.status === "error") {
				this.rejectRequest(Number(id), new Error(String(resultValue.message ?? "Rust Code Mode operation failed")));
			} else if (type === "execute/initialResponse") {
				this.resolveInitial(Number(id), resultValue.value);
			} else {
				this.resolveRequest(Number(id), resultValue.value);
			}
			return;
		}
		if (type === "delegate/request") {
			void this.delegate(value);
			return;
		}
		if (type === "delegate/cancel") {
			const id = Number(value.id);
			if (Number.isSafeInteger(id)) this.delegateAbort.get(id)?.abort();
			return;
		}
		if (type === "cell/closed") return;
		throw new Error(`Rust Code Mode host returned unsupported message: ${String(type)}`);
	}

	private async delegate(message: Record<string, unknown>): Promise<void> {
		const id = message.id;
		const request = message.request;
		if (!Number.isSafeInteger(id) || !request || typeof request !== "object") return;
		const body = request as Record<string, unknown>;
		const controller = new AbortController();
		this.delegateAbort.set(Number(id), controller);
		try {
			if (body.type === "notification/send") {
				const cellId = String(body.cellId ?? "");
				this.bridge.notify(String(body.text ?? ""), Number(cellId.replace(/^cell-/, "")) || undefined);
				this.send({
					type: "delegate/response",
					id,
					result: { status: "ok", value: { type: "notification/delivered" } },
				});
				return;
			}
			const invocation = body.invocation;
			if (!invocation || typeof invocation !== "object")
				throw new Error("Rust Code Mode host returned an invalid tool invocation");
			const call = invocation as Record<string, unknown>;
			const toolName = call.tool_name;
			const name =
				toolName && typeof toolName === "object" ? String((toolName as Record<string, unknown>).name ?? "") : "";
			const cellId = String(call.cell_id ?? "");
			const localId = Number(cellId.replace(/^cell-/, ""));
			const result = await this.bridge.callTool({
				cellId: Number.isSafeInteger(localId) ? localId : undefined,
				name,
				args: call.input,
				toolCallId: String(call.runtime_tool_call_id ?? ""),
				signal: this.cells.get(localId)?.signal
					? AbortSignal.any([this.cells.get(localId)!.signal!, controller.signal])
					: controller.signal,
			});
			this.send({ type: "delegate/response", id, result: { status: "ok", value: { type: "tool/result", result } } });
		} catch (error) {
			this.send({
				type: "delegate/response",
				id,
				result: {
					status: "ok",
					value: {
						type: "tool/result",
						result: { error: error instanceof Error ? error.message : String(error) },
					},
				},
			});
		} finally {
			this.delegateAbort.delete(Number(id));
		}
	}

	private resolveRequest(id: number, value: unknown): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.resolve(value);
	}

	private resolveInitial(id: number, value: unknown): void {
		const pending = this.initial.get(id);
		if (!pending) return;
		this.initial.delete(id);
		pending.resolve(value);
	}

	private rejectRequest(id: number, error: Error): void {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		pending?.reject(error);
		const initial = this.initial.get(id);
		this.initial.delete(id);
		initial?.reject(error);
	}

	private stop(error: Error): void {
		const child = this.child;
		this.child = undefined;
		this.startPromise = undefined;
		this.buffer = Buffer.alloc(0);
		this.stderr = "";
		this.waiting.clear();
		for (const pending of this.pending.values()) pending.reject(error);
		for (const pending of this.initial.values()) pending.reject(error);
		this.pending.clear();
		this.initial.clear();
		for (const controller of this.delegateAbort.values()) controller.abort();
		this.delegateAbort.clear();
		for (const [localId, cell] of this.cells) {
			this.cells.delete(localId);
			cell.reject(error);
		}
		if (child && !child.killed) child.kill();
	}
}

type RustRuntimeOutcome = {
	kind: "yielded" | "terminated" | "result";
	cellId: string;
	contentItems: unknown[];
	errorText?: string;
};

function runtimeOutcome(value: unknown): RustRuntimeOutcome | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const [variant, kind] of [
		["Yielded", "yielded"],
		["Terminated", "terminated"],
		["Result", "result"],
	] as const) {
		const body = record[variant];
		if (!body || typeof body !== "object") continue;
		const payload = body as Record<string, unknown>;
		if (typeof payload.cell_id !== "string" || !Array.isArray(payload.content_items)) return undefined;
		return {
			kind,
			cellId: payload.cell_id,
			contentItems: payload.content_items,
			...(typeof payload.error_text === "string" ? { errorText: payload.error_text } : {}),
		};
	}
	return undefined;
}

function executionCellId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return record.type === "execution/started" && typeof record.cellId === "string" ? record.cellId : undefined;
}

function wireTool(entry: ToolCatalogEntry) {
	return {
		name: entry.name,
		tool_name: { name: entry.name, namespace: null },
		description: entry.description,
		kind: "function",
		input_schema: entry.parameters ?? { type: "object", properties: {} },
		output_schema: null,
	};
}

function toCellOutcome(outcome: RustRuntimeOutcome): CellOutcome {
	const images: CellImage[] = [];
	const output: string[] = [];
	for (const item of outcome.contentItems) {
		if (!item || typeof item !== "object") continue;
		const value = item as Record<string, unknown>;
		if (value.type === "input_text" && typeof value.text === "string") output.push(value.text);
		if (value.type === "input_image" && typeof value.image_url === "string") {
			const match = value.image_url.match(/^data:([^;]+);base64,(.*)$/s);
			if (match) images.push({ mimeType: match[1]!, data: match[2]! });
		}
	}
	return {
		output: output.join("\n"),
		...(images.length ? { images } : {}),
		...(outcome.errorText ? { error: outcome.errorText } : {}),
	};
}
