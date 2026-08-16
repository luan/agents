/**
 * Payload shapes for the loopback bridge the Deno kernel calls.
 *
 * The kernel cannot see Pi, so `tools.*`, the emitters, and `notify` all arrive here as JSON over
 * HTTP. Everything on this boundary is validated: the kernel runs cell code the model wrote.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 34 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** A tool identity. `namespace` is absent for core tools. */
export interface NotebookToolName {
	name: string;
	namespace?: string;
}

export type NotebookImageDetail = "auto" | "low" | "high" | "original" | null;

/** One emitted output item. Mirrors the items the Rust host emits, so `CellOutcome` mapping is shared. */
export type NotebookContentItem =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail?: NotebookImageDetail }
	| { type: "input_audio"; audio_url: string };

export interface NotebookMemoryUsage {
	heapUsedBytes: number;
	heapTotalBytes: number;
	rssBytes: number;
	externalBytes: number;
	heapLimitBytes: number;
}

export type NotebookBridgeRequest =
	| { kind: "tool"; cellId: string; requestId: number; toolName: NotebookToolName; input: unknown }
	| { kind: "cancel_tools"; cellId: string }
	| { kind: "emit"; cellId: string; items: NotebookContentItem[] }
	| { kind: "notify"; cellId: string; text: string }
	| { kind: "yield"; cellId: string }
	| { kind: "memory"; cellId: string; usage: NotebookMemoryUsage };

export async function readNotebookBridgeRequest(request: IncomingMessage): Promise<NotebookBridgeRequest> {
	const value = JSON.parse(await readBody(request)) as unknown;
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.cellId !== "string") {
		throw new Error("Invalid notebook bridge request");
	}
	const cellId = value.cellId;
	switch (value.kind) {
		case "tool":
			return { kind: "tool", cellId, ...parseToolCall(value) };
		case "cancel_tools":
			return { kind: "cancel_tools", cellId };
		case "emit":
			return { kind: "emit", cellId, items: parseContentItems(value.items) };
		case "notify":
			if (typeof value.text !== "string") throw new Error("Invalid notebook notification");
			return { kind: "notify", cellId, text: value.text };
		case "yield":
			return { kind: "yield", cellId };
		case "memory":
			return { kind: "memory", cellId, usage: parseMemoryUsage(value.usage) };
		default:
			throw new Error(`Unsupported notebook bridge request: ${value.kind}`);
	}
}

/**
 * Writes a bounded JSON response.
 *
 * `bigint` and `Uint8Array` survive the hop as `__pi_type` envelopes, which the kernel's reviver
 * turns back into the real values.
 */
export function writeNotebookBridgeJson(response: ServerResponse, status: number, value: unknown): void {
	let body: string;
	try {
		body = JSON.stringify(value, (_key, nested: unknown) => {
			if (typeof nested === "bigint") return { __pi_type: "bigint", value: nested.toString() };
			if (nested instanceof Uint8Array) {
				return { __pi_type: "bytes", value: Buffer.from(nested).toString("base64") };
			}
			return nested;
		});
	} catch (error) {
		status = 500;
		body = JSON.stringify({ ok: false, error: `Notebook bridge result is not serializable: ${messageOf(error)}` });
	}
	if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
		status = 413;
		body = JSON.stringify({ ok: false, error: `Notebook bridge response exceeds ${MAX_RESPONSE_BYTES} bytes` });
	}
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	response.end(body);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new Error(`Notebook bridge request exceeds ${MAX_REQUEST_BYTES} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function parseToolCall(value: Record<string, unknown>): {
	requestId: number;
	toolName: NotebookToolName;
	input: unknown;
} {
	const requestId = value.requestId;
	const toolName = value.toolName;
	const namespace = isRecord(toolName) ? toolName.namespace : undefined;
	if (
		!Number.isSafeInteger(requestId) ||
		!isRecord(toolName) ||
		typeof toolName.name !== "string" ||
		(namespace !== undefined && typeof namespace !== "string")
	) {
		throw new Error("Invalid notebook tool request");
	}
	return {
		requestId: requestId as number,
		toolName: { name: toolName.name, ...(typeof namespace === "string" ? { namespace } : {}) },
		input: value.input,
	};
}

function parseContentItems(value: unknown): NotebookContentItem[] {
	if (!Array.isArray(value)) throw new Error("Notebook output items must be an array");
	return value.map((item: unknown) => {
		if (!isRecord(item)) throw new Error("Invalid notebook output item");
		if (item.type === "input_text" && typeof item.text === "string") {
			return { type: "input_text", text: item.text };
		}
		if (item.type === "input_image" && typeof item.image_url === "string") {
			const detail = item.detail;
			return {
				type: "input_image",
				image_url: item.image_url,
				...(isImageDetail(detail) ? { detail } : {}),
			};
		}
		if (item.type === "input_audio" && typeof item.audio_url === "string") {
			return { type: "input_audio", audio_url: item.audio_url };
		}
		throw new Error("Invalid notebook output item");
	});
}

function isImageDetail(value: unknown): value is NotebookImageDetail {
	return value === null || value === "auto" || value === "low" || value === "high" || value === "original";
}

function parseMemoryUsage(value: unknown): NotebookMemoryUsage {
	if (!isRecord(value)) throw new Error("Invalid notebook memory usage");
	const fields = ["heapUsedBytes", "heapTotalBytes", "rssBytes", "externalBytes", "heapLimitBytes"] as const;
	const usage = {} as NotebookMemoryUsage;
	for (const field of fields) {
		const size = value[field];
		if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
			throw new Error("Invalid notebook memory usage");
		}
		usage[field] = size;
	}
	return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
