import { TerminalProjection } from "pi-libtui/terminal";
import type { ExecProcessSnapshot, ExecSessionManager, PtyDataEvent } from "../session-manager.ts";

type ProcessControlMethods =
	| "interrupt"
	| "listProcesses"
	| "onPtyData"
	| "resize"
	| "sendInput"
	| "subscribeProcesses"
	| "terminate";

export type ProcessHubManager = ExecSessionManager & {
	[Method in ProcessControlMethods]-?: NonNullable<ExecSessionManager[Method]>;
};

export interface ProcessHubSource {
	readonly sessionId: string;
	readonly path: string;
	readonly store: ProcessTerminalStore;
	readonly manager: ProcessHubManager;
}

export interface ProcessHubSnapshot extends ExecProcessSnapshot {
	readonly key: string;
	readonly owner: string;
}

export interface ProcessHubModel {
	readonly sourceCount: number;
	list(): readonly ProcessHubSnapshot[];
	terminal(key: string): TerminalProjection | undefined;
	resize(key: string, cols: number, rows: number): Promise<boolean>;
	interrupt(key: string): Promise<boolean>;
	terminate(key: string): Promise<boolean>;
	sendInput(key: string, chars: string): Promise<boolean>;
	subscribe(listener: StoreListener): () => void;
}

export function supportsProcessHub(manager: ExecSessionManager): manager is ProcessHubManager {
	return (
		typeof manager.listProcesses === "function" &&
		typeof manager.subscribeProcesses === "function" &&
		typeof manager.onPtyData === "function" &&
		typeof manager.interrupt === "function" &&
		typeof manager.terminate === "function" &&
		typeof manager.resize === "function" &&
		typeof manager.sendInput === "function"
	);
}

type StoreListener = () => void;

export class ProcessHubCollection implements ProcessHubModel {
	readonly sourceCount: number;

	constructor(private readonly sources: readonly ProcessHubSource[]) {
		this.sourceCount = sources.length;
	}

	list(): readonly ProcessHubSnapshot[] {
		return this.sources.flatMap((source) =>
			source.store.list().map((snapshot) => ({
				...snapshot,
				key: processKey(source.sessionId, snapshot.id),
				owner: source.path,
			})),
		);
	}

	terminal(key: string): TerminalProjection | undefined {
		const target = this.resolve(key);
		return target?.source.store.terminal(target.processId);
	}

	async resize(key: string, cols: number, rows: number): Promise<boolean> {
		const target = this.resolve(key);
		return target ? target.source.store.resize(target.processId, cols, rows) : false;
	}

	async interrupt(key: string): Promise<boolean> {
		const target = this.resolve(key);
		return target ? target.source.manager.interrupt(target.processId) : false;
	}

	async terminate(key: string): Promise<boolean> {
		const target = this.resolve(key);
		return target ? target.source.manager.terminate(target.processId) : false;
	}

	async sendInput(key: string, chars: string): Promise<boolean> {
		const target = this.resolve(key);
		return target ? target.source.manager.sendInput(target.processId, chars) : false;
	}

	subscribe(listener: StoreListener): () => void {
		let initializing = true;
		const disposers = this.sources.map((source) =>
			source.store.subscribe(() => {
				if (!initializing) listener();
			}),
		);
		initializing = false;
		listener();
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	private resolve(key: string): { source: ProcessHubSource; processId: number } | undefined {
		const separator = key.lastIndexOf("\0");
		if (separator < 0) return undefined;
		const sessionId = key.slice(0, separator);
		const processId = Number(key.slice(separator + 1));
		if (!Number.isSafeInteger(processId) || processId < 0) return undefined;
		const source = this.sources.find((candidate) => candidate.sessionId === sessionId);
		return source ? { source, processId } : undefined;
	}
}

function processKey(sessionId: string, processId: number): string {
	return `${sessionId}\0${processId}`;
}

/** Retains terminal state from process start so opening the hub never replays a partial screen. */
export class ProcessTerminalStore {
	private snapshots: readonly ExecProcessSnapshot[] = [];
	private readonly terminals = new Map<number, TerminalProjection>();
	private readonly pendingResizes = new Map<number, { cols: number; rows: number }>();
	private readonly listeners = new Set<StoreListener>();
	private readonly unsubscribeProcesses: () => void;
	private readonly unsubscribePtyData: () => void;
	private disposed = false;

	constructor(private readonly manager: ProcessHubManager) {
		this.unsubscribeProcesses = manager.subscribeProcesses((snapshots) => this.replaceSnapshots(snapshots));
		this.unsubscribePtyData = manager.onPtyData((event) => this.acceptPtyData(event));
	}

	list(): readonly ExecProcessSnapshot[] {
		return this.snapshots;
	}

	terminal(processId: number): TerminalProjection | undefined {
		return this.terminals.get(processId);
	}

	/** Resize the native PTY first, then resize the projection immediately before its redraw bytes are parsed. */
	async resize(processId: number, cols: number, rows: number): Promise<boolean> {
		const pending = { cols, rows };
		this.pendingResizes.set(processId, pending);
		try {
			const resized = await this.manager.resize(processId, cols, rows);
			if (!resized && this.pendingResizes.get(processId) === pending) this.pendingResizes.delete(processId);
			return resized;
		} catch (error) {
			if (this.pendingResizes.get(processId) === pending) this.pendingResizes.delete(processId);
			throw error;
		}
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		listener();
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeProcesses();
		this.unsubscribePtyData();
		for (const terminal of this.terminals.values()) terminal.dispose();
		this.terminals.clear();
		this.pendingResizes.clear();
		this.listeners.clear();
	}

	private replaceSnapshots(snapshots: readonly ExecProcessSnapshot[]): void {
		if (this.disposed) return;
		const previous = this.snapshots;
		this.snapshots = Object.freeze([...snapshots]);
		const retainedIds = new Set(snapshots.map(({ id }) => id));
		for (const snapshot of snapshots) {
			if (!snapshot.tty || this.terminals.has(snapshot.id)) continue;
			const terminal = this.createTerminal();
			if (snapshot.output) terminal.write(snapshot.output);
			this.terminals.set(snapshot.id, terminal);
		}
		for (const [processId, terminal] of this.terminals) {
			if (retainedIds.has(processId)) continue;
			terminal.dispose();
			this.terminals.delete(processId);
		}
		if (snapshotsChanged(previous, snapshots)) this.emit();
	}

	private acceptPtyData(event: PtyDataEvent): void {
		if (this.disposed) return;
		let terminal = this.terminals.get(event.processId);
		if (!terminal) {
			terminal = this.createTerminal();
			this.terminals.set(event.processId, terminal);
		}
		const resize = this.pendingResizes.get(event.processId);
		if (resize) {
			this.pendingResizes.delete(event.processId);
			terminal.resize(resize.cols, resize.rows);
		}
		terminal.write(event.data);
	}

	private createTerminal(): TerminalProjection {
		return new TerminalProjection({ requestRender: () => this.emit() });
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

function snapshotsChanged(previous: readonly ExecProcessSnapshot[], next: readonly ExecProcessSnapshot[]): boolean {
	if (previous.length !== next.length) return true;
	return next.some((snapshot, index) => {
		const before = previous[index];
		return (
			!before ||
			before.id !== snapshot.id ||
			before.command !== snapshot.command ||
			before.cwd !== snapshot.cwd ||
			before.tty !== snapshot.tty ||
			before.stdinOpen !== snapshot.stdinOpen ||
			before.state !== snapshot.state ||
			before.exitCode !== snapshot.exitCode ||
			before.startedAtMs !== snapshot.startedAtMs ||
			before.finishedAtMs !== snapshot.finishedAtMs ||
			(!snapshot.tty && before.output !== snapshot.output) ||
			before.outputTruncated !== snapshot.outputTruncated
		);
	});
}
