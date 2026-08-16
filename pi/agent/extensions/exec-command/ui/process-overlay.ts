import { type Component, Key, matchesKey, ScrollView, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	FLOATING_HUB_CHROME_ROWS,
	floatingHubBold,
	floatingHubBorderBottom,
	floatingHubBorderTop,
	floatingHubHeight,
	floatingHubInnerWidth,
	floatingHubRow,
	floatingHubSeparator,
} from "../../shared/tui/floating-hub.ts";
import type { ExecProcessSnapshot, ExecSessionManager, PtyDataEvent } from "../tools/exec-session-manager.ts";
import { TerminalProjection } from "./terminal-projection.ts";

interface OverlayTheme {
	fg(role: string, text: string): string;
	bold?(text: string): string;
}

type ProcessSource = Pick<ExecSessionManager, "onPtyData" | "subscribeProcesses">;
type ProcessActions = Pick<ExecSessionManager, "interrupt" | "resize" | "stopSession" | "write">;
type StoreListener = (updatedPtyProcessId?: number) => void;

/**
 * Lives for the whole extension session so terminal emulation starts with the
 * first raw PTY event, not when the user opens `/ps`.
 */
export class ProcessTerminalStore {
	private snapshots: ExecProcessSnapshot[] = [];
	private readonly terminals = new Map<number, TerminalProjection>();
	private readonly snapshottedProcessIds = new Set<number>();
	private readonly listeners = new Set<StoreListener>();
	private readonly unsubscribeProcesses: () => void;
	private readonly unsubscribePtyData: () => void;
	private disposed = false;

	constructor(source: ProcessSource) {
		this.unsubscribeProcesses = source.subscribeProcesses((snapshots) => this.replaceSnapshots(snapshots));
		this.unsubscribePtyData = source.onPtyData((event) => this.acceptPtyData(event));
	}

	list(ownerSessionId: string): ExecProcessSnapshot[] {
		return this.snapshots.filter((snapshot) => snapshot.ownerSessionId === ownerSessionId);
	}

	terminal(processId: number): TerminalProjection | undefined {
		const existing = this.terminals.get(processId);
		if (existing) return existing;
		const snapshot = this.snapshots.find((item) => item.id === processId);
		if (!snapshot?.tty) return undefined;
		return this.createTerminal(processId);
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
		this.listeners.clear();
	}

	private replaceSnapshots(snapshots: ExecProcessSnapshot[]): void {
		if (this.disposed) return;
		const shouldRender = snapshotChangeNeedsRender(this.snapshots, snapshots);
		this.snapshots = snapshots.slice();
		const currentProcessIds = new Set(snapshots.map((snapshot) => snapshot.id));
		for (const processId of currentProcessIds) this.snapshottedProcessIds.add(processId);
		for (const [processId, terminal] of this.terminals) {
			if (!this.snapshottedProcessIds.has(processId) || currentProcessIds.has(processId)) continue;
			terminal.dispose();
			this.terminals.delete(processId);
		}
		if (shouldRender) this.emit();
	}

	private acceptPtyData(event: PtyDataEvent): void {
		if (this.disposed) return;
		const terminal = this.terminals.get(event.processId) ?? this.createTerminal(event.processId);
		terminal.write(event.data);
	}

	private createTerminal(processId: number): TerminalProjection {
		const terminal = new TerminalProjection(() => this.emit(processId));
		this.terminals.set(processId, terminal);
		return terminal;
	}

	private emit(updatedPtyProcessId?: number): void {
		for (const listener of this.listeners) listener(updatedPtyProcessId);
	}
}

export class ProcessOverlay implements Component {
	focused = true;
	private closed = false;
	private mode: "list" | "output" | "terminal" = "list";
	private selectedIndex = 0;
	private listOffset = 0;
	private processId: number | undefined;
	private pendingTopKey = false;
	private message: string | undefined;
	private lastResize: { processId: number; cols: number; rows: number } | undefined;
	private readonly outputLines = new MutableLines();
	private readonly outputScroll: ScrollView;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly store: ProcessTerminalStore,
		private readonly actions: ProcessActions,
		private readonly tui: Pick<TUI, "requestRender" | "terminal">,
		private readonly theme: OverlayTheme,
		private readonly ownerSessionId: string,
		private readonly done: () => void,
		selectedProcessId?: number,
	) {
		this.outputScroll = new ScrollView(this.outputLines, {
			follow: "end",
			scrollbar: "auto",
			scrollbarStyle: (text) => this.theme.fg("dim", text),
		});
		this.unsubscribe = store.subscribe((updatedPtyProcessId) => {
			if (this.closed) return;
			if (updatedPtyProcessId === undefined || updatedPtyProcessId === this.processId) this.tui.requestRender();
		});
		if (selectedProcessId !== undefined) this.openProcess(selectedProcessId);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.alt("s"))) {
			this.close();
			return;
		}
		if (this.mode === "terminal") {
			this.handleTerminalInput(data);
			return;
		}
		if (this.mode === "output") {
			this.handleOutputInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		if (width < 8) return [];
		if (this.mode === "terminal") return this.renderTerminal(width);
		if (this.mode === "output") return this.renderOutput(width);
		return this.renderList(width);
	}

	invalidate(): void {
		this.outputScroll.invalidate();
	}

	dispose(): void {
		this.close(false);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		if (data === "g") {
			if (this.pendingTopKey) this.moveSelectionToBoundary("start");
			this.pendingTopKey = !this.pendingTopKey;
			return;
		}
		this.pendingTopKey = false;
		if (isUp(data)) this.moveSelection(-1);
		else if (isDown(data)) this.moveSelection(1);
		else if (isPageUp(data)) this.moveSelection(-this.listPageSize());
		else if (isPageDown(data)) this.moveSelection(this.listPageSize());
		else if (matchesKey(data, Key.home)) this.moveSelectionToBoundary("start");
		else if (data === "G" || matchesKey(data, Key.end)) this.moveSelectionToBoundary("end");
		else if (isEnter(data)) this.openSelected();
		else if (data === "i") this.interruptSelected();
		else if (data === "x") this.terminateSelected();
	}

	private handleTerminalInput(data: string): void {
		if (data === "\u001d") {
			this.showList();
			return;
		}
		const snapshot = this.currentProcess();
		if (!snapshot) {
			this.showList("The process is gone");
			return;
		}
		if (!snapshot.stdinOpen) return;
		void this.actions.write({ process_id: snapshot.id, chars: data }).catch((error) => this.showError(error));
	}

	private handleOutputInput(data: string): void {
		if (
			data === "\u001d" ||
			matchesKey(data, Key.escape) ||
			data === "q" ||
			data === "h" ||
			matchesKey(data, Key.left)
		) {
			this.showList();
			return;
		}
		if (data === "g") {
			if (this.pendingTopKey) this.outputScroll.scrollToStart();
			this.pendingTopKey = !this.pendingTopKey;
			return;
		}
		this.pendingTopKey = false;
		if (isUp(data)) this.outputScroll.scrollBy(-1);
		else if (isDown(data)) this.outputScroll.scrollBy(1);
		else if (isPageUp(data)) this.outputScroll.scrollBy(-Math.max(1, this.outputScroll.viewportHeight));
		else if (isPageDown(data)) this.outputScroll.scrollBy(Math.max(1, this.outputScroll.viewportHeight));
		else if (matchesKey(data, Key.home)) this.outputScroll.scrollToStart();
		else if (data === "G" || matchesKey(data, Key.end)) this.outputScroll.scrollToEnd();
		else if (data === "i") this.interruptCurrent();
		else if (data === "x") this.terminateCurrent();
	}

	private renderList(width: number): string[] {
		const innerWidth = floatingHubInnerWidth(width);
		const snapshots = this.processes();
		this.clampSelection(snapshots.length);
		const outerRows = floatingHubHeight(this.tui.terminal.rows);
		const bodyRows = Math.max(1, outerRows - FLOATING_HUB_CHROME_ROWS - (this.message ? 1 : 0));
		this.syncListOffset(snapshots.length, bodyRows);
		const visible = snapshots.slice(this.listOffset, this.listOffset + bodyRows);
		const running = snapshots.filter((snapshot) => snapshot.state === "running").length;
		const lines = [
			this.borderTop(width),
			this.row(
				`${this.bold("processes")} ${this.theme.fg("dim", `${snapshots.length} current-session`)}`,
				innerWidth,
			),
			this.row(
				this.theme.fg(
					"dim",
					"j/k move · gg/Home top · G/End bottom · enter open · i interrupt · x terminate · alt+s/q/esc close",
				),
				innerWidth,
			),
			this.separator(innerWidth),
		];
		if (visible.length === 0)
			lines.push(this.row(this.theme.fg("muted", "No processes in this session"), innerWidth));
		for (const [offset, snapshot] of visible.entries()) {
			lines.push(this.row(this.processLine(snapshot, this.listOffset + offset === this.selectedIndex), innerWidth));
		}
		const bodyEnd = outerRows - 3 - (this.message ? 1 : 0);
		while (lines.length < bodyEnd) lines.push(this.row("", innerWidth));
		if (this.message) lines.push(this.row(this.theme.fg("accent", this.message), innerWidth));
		lines.push(this.separator(innerWidth));
		lines.push(
			this.row(this.theme.fg("dim", `${running} running · ${snapshots.length - running} finished`), innerWidth),
		);
		lines.push(this.borderBottom(width));
		return lines;
	}

	private renderTerminal(width: number): string[] {
		const snapshot = this.currentProcess();
		if (!snapshot) return this.renderMissingProcess(width);
		const innerWidth = floatingHubInnerWidth(width);
		const viewportRows = Math.max(1, floatingHubHeight(this.tui.terminal.rows) - FLOATING_HUB_CHROME_ROWS);
		const terminal = this.store.terminal(snapshot.id);
		if (!terminal) {
			this.mode = "output";
			return this.renderOutput(width);
		}
		if (terminal.resize(innerWidth, viewportRows)) this.resizePty(snapshot.id, innerWidth, viewportRows);
		const projected = terminal.renderLines();
		const body = projected.slice(0, viewportRows);
		while (body.length < viewportRows) body.push("");
		return this.detailFrame(
			width,
			snapshot,
			"terminal input active · ctrl+] back",
			body,
			`${terminal.cols}x${terminal.rows}`,
		);
	}

	private renderOutput(width: number): string[] {
		const snapshot = this.currentProcess();
		if (!snapshot) return this.renderMissingProcess(width);
		const innerWidth = floatingHubInnerWidth(width);
		const viewportRows = Math.max(1, floatingHubHeight(this.tui.terminal.rows) - FLOATING_HUB_CHROME_ROWS);
		const wrapped = outputForRender(snapshot.output, innerWidth);
		this.outputLines.lines = wrapped.length > 0 ? wrapped : [this.theme.fg("muted", "No output yet")];
		this.outputScroll.updateLayout(this.outputLines.lines.length, viewportRows, () => this.tui.requestRender());
		const allLines = this.outputScroll.render(innerWidth);
		const body = allLines.slice(this.outputScroll.scrollTop, this.outputScroll.scrollTop + viewportRows);
		while (body.length < viewportRows) body.push("");
		const first = this.outputLines.lines.length === 0 ? 0 : this.outputScroll.scrollTop + 1;
		const last = Math.min(this.outputLines.lines.length, this.outputScroll.scrollTop + viewportRows);
		return this.detailFrame(
			width,
			snapshot,
			"j/k scroll · ctrl-u/d page · gg/Home top · G/End bottom · i interrupt · x terminate · alt+s close · ctrl+] back",
			body,
			`${first}-${last} of ${this.outputLines.lines.length} lines`,
		);
	}

	private detailFrame(
		width: number,
		snapshot: ExecProcessSnapshot,
		help: string,
		body: string[],
		footer: string,
	): string[] {
		const innerWidth = floatingHubInnerWidth(width);
		const state =
			snapshot.state === "running"
				? this.theme.fg("accent", "running")
				: this.theme.fg("muted", snapshot.exitCode === undefined ? snapshot.state : `exited ${snapshot.exitCode}`);
		return [
			this.borderTop(width),
			this.row(`${this.bold(`process #${snapshot.id}`)} ${this.theme.fg("dim", snapshot.name)}`, innerWidth),
			this.row(this.theme.fg("dim", help), innerWidth),
			this.row(`${state}${this.theme.fg("dim", " · ")}${sanitizeLine(snapshot.command)}`, innerWidth),
			this.separator(innerWidth),
			...body.map((line) => this.row(line, innerWidth)),
			this.row(this.theme.fg("dim", footer), innerWidth),
			this.borderBottom(width),
		];
	}

	private renderMissingProcess(width: number): string[] {
		this.mode = "list";
		this.processId = undefined;
		this.message = "The process is gone";
		return this.renderList(width);
	}

	private processLine(snapshot: ExecProcessSnapshot, selected: boolean): string {
		const state =
			snapshot.state === "running"
				? this.theme.fg("accent", "running")
				: this.theme.fg("muted", snapshot.exitCode === undefined ? snapshot.state : `exited ${snapshot.exitCode}`);
		const kind = this.theme.fg("mdLink", snapshot.tty ? "tty" : "pipe");
		return `${selected ? this.theme.fg("accent", ">") : " "} #${snapshot.id} ${state}${this.theme.fg("dim", " · ")}${kind}${this.theme.fg("dim", " · ")}${sanitizeLine(snapshot.command)}`;
	}

	private openSelected(): void {
		const snapshot = this.processes()[this.selectedIndex];
		if (!snapshot) {
			this.message = "No process selected";
			this.tui.requestRender();
			return;
		}
		this.openProcess(snapshot.id);
	}

	private openProcess(processId: number): void {
		const snapshot = this.processes().find((item) => item.id === processId);
		if (!snapshot) return;
		this.processId = processId;
		this.mode = snapshot.tty ? "terminal" : "output";
		this.message = undefined;
		this.outputScroll.scrollToEnd();
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		const count = this.processes().length;
		if (count === 0) return;
		this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.syncListOffset(count, this.listPageSize());
		this.message = undefined;
		this.tui.requestRender();
	}

	private moveSelectionToBoundary(boundary: "start" | "end"): void {
		const count = this.processes().length;
		if (count === 0) return;
		this.selectedIndex = boundary === "start" ? 0 : count - 1;
		this.syncListOffset(count, this.listPageSize());
		this.message = undefined;
		this.tui.requestRender();
	}

	private interruptSelected(): void {
		const snapshot = this.processes()[this.selectedIndex];
		if (snapshot) this.runInterrupt(snapshot.id);
	}

	private interruptCurrent(): void {
		if (this.processId !== undefined) this.runInterrupt(this.processId);
	}

	private runInterrupt(processId: number): void {
		void this.actions
			.interrupt(processId)
			.then((interrupted) => {
				this.message = interrupted ? `Interrupted process #${processId}` : `Process #${processId} is gone`;
			})
			.catch((error) => {
				this.message = errorMessage(error);
			})
			.finally(() => this.tui.requestRender());
	}

	private terminateSelected(): void {
		const snapshot = this.processes()[this.selectedIndex];
		if (!snapshot) return;
		const stopped = this.actions.stopSession(snapshot.id);
		this.message = stopped ? `Terminated process #${snapshot.id}` : `Process #${snapshot.id} is gone`;
		this.tui.requestRender();
	}

	private terminateCurrent(): void {
		if (this.processId === undefined) return;
		const processId = this.processId;
		const stopped = this.actions.stopSession(processId);
		this.showList(stopped ? `Terminated process #${processId}` : `Process #${processId} is gone`);
	}

	private resizePty(processId: number, cols: number, rows: number): void {
		if (this.lastResize?.processId === processId && this.lastResize.cols === cols && this.lastResize.rows === rows)
			return;
		this.lastResize = { processId, cols, rows };
		void this.actions.resize(processId, cols, rows).catch((error) => this.showError(error));
	}

	private showList(message?: string): void {
		this.mode = "list";
		this.processId = undefined;
		this.message = message;
		this.tui.requestRender();
	}

	private showError(error: unknown): void {
		this.message = errorMessage(error);
		this.tui.requestRender();
	}

	private currentProcess(): ExecProcessSnapshot | undefined {
		return this.processes().find((snapshot) => snapshot.id === this.processId);
	}

	private processes(): ExecProcessSnapshot[] {
		return this.store.list(this.ownerSessionId);
	}

	private listPageSize(): number {
		return Math.max(1, floatingHubHeight(this.tui.terminal.rows) - FLOATING_HUB_CHROME_ROWS);
	}

	private clampSelection(count: number): void {
		this.selectedIndex = Math.max(0, Math.min(Math.max(0, count - 1), this.selectedIndex));
		this.listOffset = Math.max(0, Math.min(Math.max(0, count - 1), this.listOffset));
	}

	private syncListOffset(count: number, rows: number): void {
		if (this.selectedIndex < this.listOffset) this.listOffset = this.selectedIndex;
		if (this.selectedIndex >= this.listOffset + rows) this.listOffset = this.selectedIndex - rows + 1;
		this.listOffset = Math.max(0, Math.min(Math.max(0, count - rows), this.listOffset));
	}

	private close(callDone = true): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		if (callDone) this.done();
	}

	private row(content: string, innerWidth: number): string {
		return floatingHubRow(this.theme, content, innerWidth);
	}

	private separator(innerWidth: number): string {
		return floatingHubSeparator(this.theme, innerWidth);
	}

	private borderTop(width: number): string {
		return floatingHubBorderTop(this.theme, width);
	}

	private borderBottom(width: number): string {
		return floatingHubBorderBottom(this.theme, width);
	}

	private bold(text: string): string {
		return floatingHubBold(this.theme, text);
	}
}

class MutableLines implements Component {
	lines: string[] = [];

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function outputForRender(output: string, width: number): string[] {
	return output
		.replace(/\n$/, "")
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line.replace(/\t/g, "    "), Math.max(1, width)));
}

function snapshotChangeNeedsRender(previous: ExecProcessSnapshot[], next: ExecProcessSnapshot[]): boolean {
	if (previous.length !== next.length) return true;
	for (let index = 0; index < next.length; index += 1) {
		const before = previous[index];
		const after = next[index];
		if (!before || !after) return true;
		if (
			before.id !== after.id ||
			before.name !== after.name ||
			before.command !== after.command ||
			before.cwd !== after.cwd ||
			before.ownerSessionId !== after.ownerSessionId ||
			before.tty !== after.tty ||
			before.stdinOpen !== after.stdinOpen ||
			before.state !== after.state ||
			before.exitCode !== after.exitCode ||
			before.startedAtMs !== after.startedAtMs ||
			before.finishedAtMs !== after.finishedAtMs ||
			before.outputTruncated !== after.outputTruncated ||
			(!after.tty && before.output !== after.output)
		)
			return true;
	}
	return false;
}

function sanitizeLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUp(data: string): boolean {
	return matchesKey(data, Key.up) || data === "k";
}

function isDown(data: string): boolean {
	return matchesKey(data, Key.down) || data === "j";
}

function isPageUp(data: string): boolean {
	return matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")) || data === "\u0015";
}

function isPageDown(data: string): boolean {
	return matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d")) || data === "\u0004";
}

function isEnter(data: string): boolean {
	return matchesKey(data, Key.enter) || data === "\r" || data === "\n";
}
