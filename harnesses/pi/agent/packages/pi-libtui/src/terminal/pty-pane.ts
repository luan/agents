import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, ScrollView, type TUI } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "../mouse.ts";
import { ensurePtyHost, type PtyHost } from "./pty-host.ts";

export interface PtyProcessOptions {
	readonly label: string;
	readonly command: string;
	readonly context: Pick<ExtensionContext, "cwd" | "ui">;
	readonly onExit: () => void;
	readonly scope: typeof globalThis;
}

interface PtySize {
	readonly columns: number;
	readonly rows: number;
}

function samePtySize(left: PtySize | undefined, right: PtySize): boolean {
	return left?.columns === right.columns && left.rows === right.rows;
}

/** One reusable PTY lifecycle independent from its side-panel or overlay presentation. */
export class PtyProcess {
	private host: PtyHost | undefined;
	private processId: string | undefined;
	private starting: Promise<void> | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly renderListeners = new Set<(interactive: boolean) => void>();
	private pendingInput = "";
	private pendingSize: PtySize | undefined;
	private appliedSize: PtySize | undefined;
	private pumping = false;
	private interactiveRenderPending = false;
	private visible = false;
	private reportedVisible: boolean | undefined;
	private exitReported = false;
	private disposed = false;
	private onExit: (() => void) | undefined;
	constructor(private readonly options: PtyProcessOptions) {
		this.onExit = options.onExit;
	}

	/** Transfer exit ownership when a presentation host is reloaded. */
	setOnExit(listener: (() => void) | undefined): void {
		this.onExit = listener;
		if (listener && this.exitReported) queueMicrotask(listener);
	}

	subscribeRender(listener: (interactive: boolean) => void): () => void {
		this.renderListeners.add(listener);
		return () => this.renderListeners.delete(listener);
	}

	private start(): void {
		if (this.disposed || this.exitReported) return;
		this.host ??= ensurePtyHost(this.options.scope);
		const host = this.host;
		if ((this.processId !== undefined && host.isRunning(this.processId)) || this.starting) return;
		const initialSize = this.pendingSize;
		this.starting = host
			.spawn({
				command: this.options.command,
				cwd: this.options.context.cwd,
				...(initialSize ? { columns: initialSize.columns, rows: initialSize.rows } : {}),
			})
			.then((processId) => {
				if (this.disposed) return void host.terminate(processId).catch(() => undefined);
				this.processId = processId;
				if (initialSize) {
					this.appliedSize = initialSize;
					if (samePtySize(this.pendingSize, initialSize)) this.pendingSize = undefined;
				}
				this.unsubscribe = host.subscribe(processId, () => this.hostUpdated());
				this.hostUpdated();
				this.schedulePump();
			})
			.catch((error) => this.fail(error))
			.finally(() => {
				this.starting = undefined;
			});
	}

	render(columns: number, rows: number, cursor: boolean): readonly string[] {
		this.queueResize({ columns, rows });
		if (this.processId === undefined) {
			void this.start();
			return [`Starting ${this.options.label}…`];
		}
		return this.host?.render(this.processId, rows, cursor) ?? [];
	}

	sendInput(data: string): void {
		if (!data || this.disposed) return;
		this.pendingInput += data;
		this.schedulePump();
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.syncVisibility();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pendingInput = "";
		this.pendingSize = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const processId = this.processId;
		this.processId = undefined;
		if (processId !== undefined) void this.host?.terminate(processId).catch(() => undefined);
	}

	private hostUpdated(): void {
		this.syncVisibility();
		const interactive = this.interactiveRenderPending;
		this.interactiveRenderPending = false;
		this.notifyRender(interactive);
		const host = this.host;
		if (!host) return;
		if (!this.disposed && this.processId !== undefined && !host.isRunning(this.processId)) this.reportExit();
	}

	private notifyRender(interactive = false): void {
		for (const listener of this.renderListeners) listener(interactive);
	}

	private syncVisibility(): void {
		if (this.reportedVisible === this.visible || this.processId === undefined || this.disposed) return;
		const host = this.host;
		if (!host) return;
		if (!host.acceptsFocusEvents(this.processId)) return;
		this.reportedVisible = this.visible;
		this.sendInput(this.visible ? "\x1b[I" : "\x1b[O");
	}

	private queueResize(size: PtySize): void {
		if (samePtySize(this.pendingSize ?? this.appliedSize, size)) return;
		this.pendingSize = size;
		this.schedulePump();
	}

	private schedulePump(): void {
		if (this.pumping || (!this.pendingSize && !this.pendingInput) || this.processId === undefined || this.disposed)
			return;
		this.pumping = true;
		queueMicrotask(() => void this.pump());
	}

	private async pump(): Promise<void> {
		try {
			while ((this.pendingSize || this.pendingInput) && !this.disposed) {
				const host = this.host;
				if (this.processId === undefined) return;
				if (!host) return;
				const size = this.pendingSize;
				this.pendingSize = undefined;
				if (size && (await host.resize(this.processId, size.columns, size.rows))) this.appliedSize = size;
				const data = this.pendingInput;
				this.pendingInput = "";
				if (data) {
					// Mark latency-sensitive output only once the bytes are actually crossing
					// the bridge; unrelated animation output must not consume this priority.
					this.interactiveRenderPending = true;
					await host.sendInput(this.processId, data);
				}
			}
		} catch (error) {
			this.notify(error);
		} finally {
			this.pumping = false;
			this.schedulePump();
		}
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		this.notify(error);
		this.reportExit();
	}

	private reportExit(): void {
		if (this.exitReported) return;
		this.exitReported = true;
		this.onExit?.();
	}

	private notify(error: unknown): void {
		this.options.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export interface PtyPaneOptions {
	readonly tui: TUI;
	readonly rows: () => number;
	readonly requestRender: () => void;
}

class ProjectedPtyScreen implements Component {
	constructor(
		private readonly process: PtyProcess,
		private readonly cursor: () => boolean,
		private readonly rows: () => number,
	) {}

	render(width: number): string[] {
		const rows = Math.max(1, this.rows());
		const projected = this.process.render(width, rows, this.cursor());
		if (projected.length >= rows) return projected.slice(-rows);
		return [...Array.from({ length: rows - projected.length }, () => ""), ...projected];
	}

	invalidate(): void {}
}

/** Complete cursor, keyboard, pointer, and terminal projection for one PTY process. */
export class PtyPane extends ScrollView implements Focusable {
	private _focused = false;
	private previousHardwareCursor: boolean | undefined;
	private readonly unsubscribe: () => void;
	private readonly focusState: { value: boolean };

	constructor(
		private readonly process: PtyProcess,
		private readonly options: PtyPaneOptions,
	) {
		const focusState = { value: false };
		const screen = new ProjectedPtyScreen(process, () => focusState.value, options.rows);
		super(screen, {
			follow: "end",
			overscroll: "contain",
			scrollbar: "hidden",
		});
		this.focusState = focusState;
		this.unsubscribe = process.subscribeRender((interactive) => {
			if (interactive && requestImmediateRender(options.tui)) return;
			options.requestRender();
		});
		process.setVisible(true);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.focusState.value = value;
		if (value) {
			this.previousHardwareCursor ??= this.options.tui.getShowHardwareCursor();
			this.options.tui.setShowHardwareCursor(true);
			return;
		}
		if (this.previousHardwareCursor === undefined) return;
		this.options.tui.setShowHardwareCursor(this.previousHardwareCursor);
		this.previousHardwareCursor = undefined;
	}

	handleInput(data: string): void {
		this.process.sendInput(data);
	}

	defersInputRender(): boolean {
		return true;
	}

	onMouse(event: TuiMouseEvent): boolean {
		const input = encodePointer(event);
		if (!input) return false;
		this.process.sendInput(input);
		return true;
	}

	dispose(): void {
		this.focused = false;
		this.unsubscribe();
		this.process.setVisible(false);
	}
}

// type-boundary: Pi's TUI currently keeps its latency-sensitive render path private;
// the PTY surface uses it only for the first child frame caused by keyboard input.
type InteractiveTui = TUI & { requestImmediateRender?: () => void };

function requestImmediateRender(tui: TUI): boolean {
	const render = (tui as InteractiveTui).requestImmediateRender;
	if (typeof render !== "function") return false;
	render.call(tui);
	return true;
}

function encodePointer(event: TuiMouseEvent): string | undefined {
	const modifiers = Number(event.shift) * 4 + Number(event.alt) * 8 + Number(event.ctrl) * 16;
	if (event.type === "wheel" && event.wheel !== undefined) {
		const button = event.wheel > 0 ? 65 : 64;
		return `\x1b[<${button + modifiers};${event.col + 1};${event.row + 1}M`.repeat(Math.abs(event.wheel));
	}
	if (event.type === "press" && event.button !== undefined)
		return `\x1b[<${event.button + modifiers};${event.col + 1};${event.row + 1}M`;
	if (event.type === "drag" && event.button !== undefined)
		return `\x1b[<${32 + event.button + modifiers};${event.col + 1};${event.row + 1}M`;
	if (event.type === "release") return `\x1b[<${(event.button ?? 0) + modifiers};${event.col + 1};${event.row + 1}m`;
	if (event.type === "move") return `\x1b[<${35 + modifiers};${event.col + 1};${event.row + 1}M`;
	return undefined;
}
