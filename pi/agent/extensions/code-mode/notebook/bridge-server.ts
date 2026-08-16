/**
 * Loopback HTTP bridge between the Deno kernel and the extension.
 *
 * The kernel is a separate process with no view of Pi, so `tools.*` and the emitters POST here. The
 * server binds `127.0.0.1` on an ephemeral port and demands a bearer token, so nothing else on the
 * machine can drive Pi's tools.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { NestedToolResult } from "../nested-dispatch.ts";
import {
	messageOf,
	type NotebookBridgeRequest,
	type NotebookContentItem,
	type NotebookMemoryUsage,
	type NotebookToolName,
	readNotebookBridgeRequest,
	writeNotebookBridgeJson,
} from "./bridge-protocol.ts";

// A cell can hold a keep-alive socket open forever. `close()` waits this long, then kills sockets.
const SHUTDOWN_GRACE_MS = 1_500;

export interface NotebookToolRequest {
	cellId: string;
	requestId: number;
	toolName: NotebookToolName;
	input: unknown;
}

export interface NotebookBridgeHandlers {
	callTool(request: NotebookToolRequest): Promise<NestedToolResult>;
	cancelTools(cellId: string): void;
	emit(cellId: string, items: NotebookContentItem[]): void;
	notify(cellId: string, text: string): void;
	yield(cellId: string): void;
	memory?(cellId: string, usage: NotebookMemoryUsage): void;
}

export interface NotebookBridge {
	/** `http://127.0.0.1:<ephemeral port>`. Pass it to `notebookBootstrapSource`. */
	origin: string;
	token: string;
	close(): Promise<void>;
}

export async function startNotebookBridge(handlers: NotebookBridgeHandlers): Promise<NotebookBridge> {
	const token = randomBytes(32).toString("hex");
	const server = createServer((request, response) => {
		void handle(handlers, token, request, response);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Notebook bridge did not bind a TCP port");
	}

	let closing: Promise<void> | undefined;
	return {
		origin: `http://127.0.0.1:${address.port}`,
		token,
		close() {
			closing ??= new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeIdleConnections();
				const timer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
				timer.unref?.();
			});
			return closing;
		},
	};
}

async function handle(
	handlers: NotebookBridgeHandlers,
	token: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	// Both checks run before the body is read, so an unauthorized caller never gets to spend memory here.
	if (request.headers.authorization !== `Bearer ${token}`) {
		writeNotebookBridgeJson(response, 401, { ok: false, error: "Unauthorized" });
		return;
	}
	if (request.method !== "POST" || request.url !== "/bridge") {
		writeNotebookBridgeJson(response, 404, { ok: false, error: "Not found" });
		return;
	}

	let value: NotebookBridgeRequest;
	try {
		value = await readNotebookBridgeRequest(request);
	} catch (error) {
		writeNotebookBridgeJson(response, 400, { ok: false, error: messageOf(error) });
		return;
	}

	if (value.kind === "tool") {
		// A failed tool resolves as `{ error }` rather than rejecting, matching rust-kernel.ts:394.
		// Cell code reads the field; it does not have to wrap every call in try/catch.
		let result: NestedToolResult | { error: string };
		try {
			result = await handlers.callTool(value);
		} catch (error) {
			result = { error: messageOf(error) };
		}
		writeNotebookBridgeJson(response, 200, { ok: true, result });
		return;
	}

	try {
		switch (value.kind) {
			case "cancel_tools":
				handlers.cancelTools(value.cellId);
				break;
			case "emit":
				handlers.emit(value.cellId, value.items);
				break;
			case "notify":
				handlers.notify(value.cellId, value.text);
				break;
			case "yield":
				handlers.yield(value.cellId);
				break;
			case "memory":
				handlers.memory?.(value.cellId, value.usage);
				break;
		}
	} catch (error) {
		writeNotebookBridgeJson(response, 400, { ok: false, error: messageOf(error) });
		return;
	}
	writeNotebookBridgeJson(response, 200, { ok: true });
}
