/**
 * Notebook Code Mode's cell kernel, the only export the rest of code-mode sees.
 *
 * It mirrors `RustCellKernel`'s public shape, so `CellSession` can hold either kernel and
 * render.ts:1 draws one `CellOutcome` for both.
 */

import type { NestedToolResult, ToolCatalogEntry } from "../nested-dispatch.ts";
import { preprocessRawBlockLiterals } from "../payload.ts";
import type { CellOutcome, HostBridge } from "../rust-kernel.ts";
import type { NotebookToolRequest } from "./bridge-server.ts";
import { NotebookCell } from "./cell.ts";
import type { NotebookHostClient } from "./host-client.ts";
import { NOTEBOOK_RUNTIME_GLOBAL } from "./kernel-bootstrap.ts";
import { type NotebookOptions, NotebookSession } from "./session.ts";

export type { NotebookOptions } from "./session.ts";

export class NotebookCellKernel {
	private readonly cells = new Map<string, NotebookCell>();
	private readonly session: NotebookSession;

	constructor(
		private readonly bridge: HostBridge,
		options: NotebookOptions = {},
	) {
		this.session = new NotebookSession(
			{
				callTool: (request) => this.callTool(request),
				cancelTools: (cellId) => this.cells.get(cellId)?.controller.abort(),
				emit: (cellId, items) => this.cells.get(cellId)?.applyItems(items),
				notify: (cellId, text) => this.bridge.notify(text, localIdOf(cellId)),
				// This kernel returns one outcome per cell, so there is nothing to yield early.
				yield: () => {},
			},
			options,
		);
	}

	get running(): boolean {
		return this.cells.size > 0;
	}

	async execute(
		localId: number,
		source: string,
		catalog: ToolCatalogEntry[],
		signal?: AbortSignal,
	): Promise<CellOutcome> {
		if (signal?.aborted) throw new Error(`cell ${localId} interrupted`);
		const id = `cell-${localId}`;
		const cell = new NotebookCell(id, localId);
		// Registered before the first await, so `running` is true the moment the caller returns.
		this.cells.set(id, cell);
		let client: NotebookHostClient | undefined;
		const onAbort = () => {
			void client?.interrupt().catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			client = await this.session.ensure(signal);
			await client.execute(notebookCellSource(id, source, catalog), (output) => cell.applyOutput(output));
			if (signal?.aborted) throw new Error(`cell ${localId} interrupted`);
			return cell.outcome();
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.cells.delete(id);
			// The cell is over. Anything it left in flight has nowhere to report.
			cell.controller.abort();
		}
	}

	/**
	 * The name `CellSession` calls. `yieldTimeMs` is accepted and ignored: runtime.ts:352 races its
	 * own timer against this promise, so the yield window is enforced host-side either way.
	 */
	run(
		localId: number,
		source: string,
		catalog: ToolCatalogEntry[],
		signal?: AbortSignal,
		_yieldTimeMs?: number,
	): Promise<CellOutcome> {
		return this.execute(localId, source, catalog, signal);
	}

	/**
	 * A no-op. The Rust host extends a kernel-side yield window here (rust-kernel.ts:91); this kernel
	 * has none, and `run` already resolves only when the cell finishes.
	 */
	wait(_localId: number, _yieldTimeMs: number): void {}

	/**
	 * Names the kernel offers for a prefix. This is the only way to see a top-level `let` or `const`:
	 * they live in the global lexical scope, out of reach of `Object.getOwnPropertyNames(globalThis)`.
	 */
	async complete(prefix: string, cursor = prefix.length, signal?: AbortSignal): Promise<string[]> {
		const client = await this.session.ensure(signal);
		return client.complete(prefix, cursor);
	}

	/** Drops the kernel and its state. The next cell starts a fresh one. */
	reset(): void {
		this.dispose();
	}

	dispose(): void {
		for (const cell of this.cells.values()) cell.controller.abort();
		this.cells.clear();
		this.session.dispose();
	}

	private callTool(request: NotebookToolRequest): Promise<NestedToolResult> {
		const cell = this.cells.get(request.cellId);
		const localId = localIdOf(request.cellId);
		return this.bridge.callTool({
			...(localId === undefined ? {} : { cellId: localId }),
			name: request.toolName.name,
			args: request.input,
			// One id per call, so the row and the execution share it the way fileops' latest-turn gate needs.
			toolCallId: `${request.cellId}-${request.requestId}`,
			...(cell ? { signal: cell.controller.signal } : {}),
		});
	}
}

/**
 * Frames one cell for the kernel.
 *
 * `begin` and `flush` are the two halves of kernel-bootstrap.ts:194. The three statements stay at
 * the top level: a wrapping block would scope the cell's `const` and `let` bindings to that block,
 * and cross-cell state is the whole point of a notebook.
 */
export function notebookCellSource(cellId: string, source: string, catalog: ToolCatalogEntry[]): string {
	const tools = catalog.map((entry) => ({ name: entry.name, description: entry.description }));
	const toolNames = Object.fromEntries(catalog.map((entry) => [entry.name, { name: entry.name }]));
	const runtime = `globalThis.${NOTEBOOK_RUNTIME_GLOBAL}`;
	return [
		`await ${runtime}.begin(${JSON.stringify(cellId)}, ${JSON.stringify(tools)}, ${JSON.stringify(toolNames)});`,
		preprocessRawBlockLiterals(source),
		`await ${runtime}.flush(${JSON.stringify(cellId)});`,
		// Swallows the cell's last value. Output is what `text()` and the emitters reported.
		"undefined;",
	].join("\n");
}

function localIdOf(cellId: string): number | undefined {
	const localId = Number(cellId.replace(/^cell-/, ""));
	return Number.isSafeInteger(localId) ? localId : undefined;
}
