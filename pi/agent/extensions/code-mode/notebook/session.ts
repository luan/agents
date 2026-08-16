/**
 * Kernel and bridge lifecycle for Notebook Code Mode.
 *
 * One session owns one loopback bridge and one host client. Both are built on the first cell and
 * reused by every later cell, which is what makes state persist across cells.
 */

import { type NotebookBridge, type NotebookBridgeHandlers, startNotebookBridge } from "./bridge-server.ts";
import { NotebookCell } from "./cell.ts";
import { ensureDenoBinary } from "./deno-binary.ts";
import { NotebookHostClient } from "./host-client.ts";
import { notebookBootstrapSource } from "./kernel-bootstrap.ts";

export interface NotebookOptions {
	/** Working directory of the kernel process. Defaults to the agent's own. */
	cwd?: string;
	/** A verified Deno binary. Absent, `ensureDenoBinary()` downloads and verifies one. */
	denoPath?: string;
	/** Node executable for the sidecar. Resolved from PATH by default. */
	node?: string;
	/** Path of `host/host.mjs`. Tests point it at a fake host. */
	hostScript?: string;
}

export class NotebookSession {
	private client: NotebookHostClient | undefined;
	private bridge: NotebookBridge | undefined;
	private starting: Promise<NotebookHostClient> | undefined;

	constructor(
		private readonly handlers: NotebookBridgeHandlers,
		private readonly options: NotebookOptions = {},
	) {}

	/** Returns a live kernel, starting one if this is the first cell or the last kernel died. */
	ensure(signal?: AbortSignal): Promise<NotebookHostClient> {
		if (this.client && !this.client.alive) this.discard();
		if (this.client) return Promise.resolve(this.client);
		this.starting ??= this.open(signal).catch((error: unknown) => {
			this.starting = undefined;
			throw error;
		});
		return this.starting;
	}

	dispose(): void {
		const client = this.client;
		const bridge = this.bridge;
		this.client = undefined;
		this.bridge = undefined;
		this.starting = undefined;
		void client?.shutdown().catch(() => client.dispose());
		void bridge?.close().catch(() => undefined);
	}

	private async open(signal?: AbortSignal): Promise<NotebookHostClient> {
		const deno = this.options.denoPath ?? (await ensureDenoBinary(signal));
		signal?.throwIfAborted();
		const bridge = await startNotebookBridge(this.handlers);
		const client = new NotebookHostClient({
			...(this.options.node ? { node: this.options.node } : {}),
			...(this.options.hostScript ? { script: this.options.hostScript } : {}),
		});
		try {
			// The bootstrap runs as a normal cell, not as the host's `bootstrap` argument: host.mjs:242
			// waits out its whole 30 s timeout because nothing resolves a silent execute, and it drops
			// the error when the bootstrap fails. A plain execute finishes in milliseconds and reports.
			await client.start(deno, this.options.cwd ?? process.cwd(), "");
			await this.bootstrap(client, bridge);
		} catch (error) {
			client.dispose();
			await bridge.close().catch(() => undefined);
			throw error;
		}
		this.client = client;
		this.bridge = bridge;
		return client;
	}

	/** Installs `tools`, the emitters, and store/load. A cell is useless without them. */
	private async bootstrap(client: NotebookHostClient, bridge: NotebookBridge): Promise<void> {
		const cell = new NotebookCell("bootstrap", 0);
		await client.execute(notebookBootstrapSource(bridge.origin, bridge.token), (output) => cell.applyOutput(output));
		const error = cell.outcome().error;
		if (error) throw new Error(`Notebook bootstrap failed: ${error}`);
	}

	/** Drops a dead kernel so the next cell starts a clean one. */
	private discard(): void {
		this.client?.dispose();
		this.client = undefined;
		this.starting = undefined;
		void this.bridge?.close().catch(() => undefined);
		this.bridge = undefined;
	}
}
