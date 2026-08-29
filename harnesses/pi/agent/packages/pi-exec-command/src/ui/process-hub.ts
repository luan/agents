import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { applyScrollbar, FullscreenOverlay, fullscreenOverlayOptions, SelectableList, tuiTheme } from "pi-libtui";
import {
	ProcessHubCollection,
	type ProcessHubModel,
	type ProcessHubSnapshot,
	type ProcessHubSource,
} from "./process-store.ts";

type ProcessHubMode = "list" | "output" | "terminal";

/** Process browser. Execution and process lifetime remain manager-owned. */
export class ProcessHub {
	focused = true;
	private mode: ProcessHubMode = "list";
	private selectedKey: string | undefined;
	private processKey: string | undefined;
	private outputOffset = 0;
	private followOutput = true;
	private pendingTopKey = false;
	private message: string | undefined;
	private closed = false;
	private bodyRows = 1;
	private lastResize: { processKey: string; cols: number; rows: number } | undefined;
	private readonly list: SelectableList<ProcessHubSnapshot>;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly model: ProcessHubModel,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		initialProcessKey?: string,
	) {
		const snapshots = model.list();
		this.selectedKey = snapshots[0]?.key;
		this.list = new SelectableList({
			items: snapshots,
			wrap: false,
			requestRender: () => this.tui.requestRender(),
			onSelectionChange: (snapshot) => {
				this.selectedKey = snapshot.key;
				this.message = undefined;
			},
			onActivate: (snapshot) => this.openProcess(snapshot.key),
			renderItem: (snapshot, context) => this.processRow(snapshot, context.selected || context.hovered),
		});
		this.unsubscribe = model.subscribe(() => this.syncSnapshots());
		if (initialProcessKey) this.openProcess(initialProcessKey);
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

	onMouse(event: Parameters<SelectableList<ProcessHubSnapshot>["onMouse"]>[0]): boolean {
		if (this.mode === "list") return this.list.onMouse({ ...event, row: event.row - 3 });
		if (this.mode === "output" && event.type === "wheel" && event.wheel !== undefined) {
			this.scrollOutput(event.wheel * 3);
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		if (width < 8) return [];
		this.bodyRows = Math.max(1, this.tui.terminal.rows - 7);
		if (this.mode === "terminal") return this.renderTerminal(width);
		if (this.mode === "output") return this.renderOutput(width);
		return this.renderList(width);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	dispose(): void {
		this.cleanup();
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		if (data === "g") {
			if (this.pendingTopKey) this.selectBoundary("start");
			this.pendingTopKey = !this.pendingTopKey;
			return;
		}
		this.pendingTopKey = false;
		if (this.list.handleInput(data)) return;
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.moveSelection(-this.bodyRows);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) this.moveSelection(this.bodyRows);
		else if (matchesKey(data, Key.home)) this.selectBoundary("start");
		else if (data === "G" || matchesKey(data, Key.end)) this.selectBoundary("end");
		else if (data === "i") this.interrupt(this.selectedKey);
		else if (data === "x") this.terminate(this.selectedKey);
	}

	private handleTerminalInput(data: string): void {
		if (data === "\u001d") {
			this.showList();
			return;
		}
		const snapshot = this.currentProcess();
		if (!snapshot) {
			this.showList("The process is gone.");
			return;
		}
		if (!snapshot.stdinOpen) return;
		void this.model
			.sendInput(snapshot.key, data)
			.then((written) => {
				if (!written) this.showList(`${processLabel(snapshot)} is gone.`);
			})
			.catch((error) => this.showError(error instanceof Error ? error.message : String(error)));
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
			if (this.pendingTopKey) {
				this.followOutput = false;
				this.outputOffset = 0;
			}
			this.pendingTopKey = !this.pendingTopKey;
			this.tui.requestRender();
			return;
		}
		this.pendingTopKey = false;
		if (data === "j" || matchesKey(data, Key.down)) this.scrollOutput(1);
		else if (data === "k" || matchesKey(data, Key.up)) this.scrollOutput(-1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.scrollOutput(-this.bodyRows);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) this.scrollOutput(this.bodyRows);
		else if (matchesKey(data, Key.home)) {
			this.followOutput = false;
			this.outputOffset = 0;
		} else if (data === "G" || matchesKey(data, Key.end)) this.followOutput = true;
		else if (data === "i") this.interrupt(this.processKey);
		else if (data === "x") this.terminate(this.processKey, true);
		this.tui.requestRender();
	}

	private renderList(width: number): string[] {
		const colors = tuiTheme(this.theme);
		const snapshots = this.model.list();
		this.list.setMaxVisible(this.bodyRows);
		const rows = this.list.render(width).slice(0, this.bodyRows);
		while (rows.length < this.bodyRows) rows.push("");
		const running = snapshots.filter(({ state }) => state === "running").length;
		return [
			colors.fg(
				"heading",
				this.theme.bold(
					`Processes · ${snapshots.length} current-${this.model.sourceCount > 1 ? "hierarchy" : "session"}`,
				),
			),
			colors.fg("text.muted", "j/k move · enter open · i interrupt · x terminate · alt+s/q/esc close"),
			colors.fg("border", "─".repeat(width)),
			...rows.map((row) => fitLine(row, width)),
			colors.fg("border", "─".repeat(width)),
			colors.fg("text.muted", this.message ?? `${running} running · ${snapshots.length - running} finished`),
		];
	}

	private renderTerminal(width: number): string[] {
		const snapshot = this.currentProcess();
		if (!snapshot) return this.renderMissingProcess(width);
		const terminal = this.model.terminal(snapshot.key);
		if (!terminal) {
			this.mode = "output";
			return this.renderOutput(width);
		}
		if (terminal.cols !== width || terminal.rows !== this.bodyRows) this.resize(snapshot.key, width, this.bodyRows);
		const body = terminal.renderLines({ maxRows: this.bodyRows, cursor: snapshot.stdinOpen });
		while (body.length < this.bodyRows) body.push("");
		return this.renderDetail(
			width,
			snapshot,
			snapshot.stdinOpen ? "terminal input active · ctrl+] back · alt+s close" : "process exited · ctrl+] back",
			body,
			`${terminal.cols}x${terminal.rows}`,
		);
	}

	private renderOutput(width: number): string[] {
		const snapshot = this.currentProcess();
		if (!snapshot) return this.renderMissingProcess(width);
		const colors = tuiTheme(this.theme);
		const lines = outputLines(snapshot.output, width);
		const content = lines.length > 0 ? lines : [colors.fg("text.muted", "No output yet.")];
		const maxOffset = Math.max(0, content.length - this.bodyRows);
		this.outputOffset = this.followOutput ? maxOffset : Math.min(this.outputOffset, maxOffset);
		const body = applyScrollbar(content.slice(this.outputOffset, this.outputOffset + this.bodyRows), {
			theme: this.theme,
			width,
			height: this.bodyRows,
			offset: this.outputOffset,
			total: content.length,
		});
		while (body.length < this.bodyRows) body.push("");
		const first = content.length === 0 ? 0 : this.outputOffset + 1;
		const last = Math.min(content.length, this.outputOffset + this.bodyRows);
		const truncation = snapshot.outputTruncated ? " · older output omitted" : "";
		return this.renderDetail(
			width,
			snapshot,
			"j/k scroll · ctrl-u/d page · i interrupt · x terminate · ctrl+] back · alt+s close",
			body,
			`${first}-${last} of ${content.length} lines${truncation}`,
		);
	}

	private renderDetail(
		width: number,
		snapshot: ProcessHubSnapshot,
		help: string,
		body: readonly string[],
		footer: string,
	): string[] {
		const colors = tuiTheme(this.theme);
		const state =
			snapshot.state === "running"
				? colors.fg("positive", "running")
				: colors.fg("text.muted", `exited ${snapshot.exitCode ?? 1}`);
		return [
			colors.fg("heading", this.theme.bold(processLabel(snapshot))),
			colors.fg("text.muted", help),
			truncateToWidth(`${state}${colors.fg("text.muted", " · ")}${sanitizeLine(snapshot.command)}`, width, ""),
			colors.fg("border", "─".repeat(width)),
			...body.map((line) => fitLine(line, width)),
			colors.fg("text.muted", this.message ?? footer),
		];
	}

	private processRow(snapshot: ProcessHubSnapshot, selected: boolean): string {
		const colors = tuiTheme(this.theme);
		const marker = selected ? colors.fg("accent", ">") : " ";
		const state =
			snapshot.state === "running"
				? colors.fg("positive", "running")
				: colors.fg("text.muted", `exited ${snapshot.exitCode ?? 1}`);
		const kind = colors.fg("info", snapshot.tty ? "tty" : "pipe");
		return `${marker} ${snapshot.owner} · #${snapshot.id} ${state}${colors.fg("text.muted", " · ")}${kind}${colors.fg("text.muted", " · ")}${sanitizeLine(snapshot.command)}`;
	}

	private syncSnapshots(): void {
		const snapshots = this.model.list();
		if (!snapshots.some(({ key }) => key === this.selectedKey)) this.selectedKey = snapshots[0]?.key;
		const index = Math.max(
			0,
			snapshots.findIndex(({ key }) => key === this.selectedKey),
		);
		this.list.setItems(snapshots, index);
		if (this.processKey !== undefined && !snapshots.some(({ key }) => key === this.processKey)) {
			this.showList("The process is gone.");
		}
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		const snapshots = this.model.list();
		if (snapshots.length === 0) return;
		const index = Math.max(0, Math.min(snapshots.length - 1, this.list.getSelectedIndex() + delta));
		this.list.setSelectedIndex(index);
		this.selectedKey = snapshots[index]?.key;
	}

	private selectBoundary(boundary: "start" | "end"): void {
		const snapshots = this.model.list();
		if (snapshots.length === 0) return;
		const index = boundary === "start" ? 0 : snapshots.length - 1;
		this.list.setSelectedIndex(index);
		this.selectedKey = snapshots[index]?.key;
		this.tui.requestRender();
	}

	private openProcess(processKey: string): void {
		const snapshot = this.model.list().find(({ key }) => key === processKey);
		if (!snapshot) return;
		this.processKey = processKey;
		this.mode = snapshot.tty ? "terminal" : "output";
		this.outputOffset = 0;
		this.followOutput = true;
		this.message = undefined;
		this.tui.requestRender();
	}

	private currentProcess(): ProcessHubSnapshot | undefined {
		return this.model.list().find(({ key }) => key === this.processKey);
	}

	private scrollOutput(delta: number): void {
		this.followOutput = false;
		this.outputOffset = Math.max(0, this.outputOffset + delta);
		this.tui.requestRender();
	}

	private interrupt(processKey: string | undefined): void {
		if (processKey === undefined) return;
		const snapshot = this.model.list().find(({ key }) => key === processKey);
		if (!snapshot) return;
		void this.model
			.interrupt(processKey)
			.then((interrupted) => {
				this.message = interrupted ? `Interrupted ${processLabel(snapshot)}.` : `${processLabel(snapshot)} is gone.`;
			})
			.catch((error) => this.showError(error instanceof Error ? error.message : String(error)))
			.finally(() => this.tui.requestRender());
	}

	private terminate(processKey: string | undefined, returnToList = false): void {
		if (processKey === undefined) return;
		const snapshot = this.model.list().find(({ key }) => key === processKey);
		if (!snapshot) return;
		void this.model
			.terminate(processKey)
			.then((terminated) => {
				const message = terminated ? `Terminated ${processLabel(snapshot)}.` : `${processLabel(snapshot)} is gone.`;
				if (returnToList) this.showList(message);
				else this.message = message;
			})
			.catch((error) => this.showError(error instanceof Error ? error.message : String(error)))
			.finally(() => this.tui.requestRender());
	}

	private resize(processKey: string, cols: number, rows: number): void {
		if (this.lastResize?.processKey === processKey && this.lastResize.cols === cols && this.lastResize.rows === rows)
			return;
		this.lastResize = { processKey, cols, rows };
		void this.model
			.resize(processKey, cols, rows)
			.catch((error) => this.showError(error instanceof Error ? error.message : String(error)));
	}

	private renderMissingProcess(width: number): string[] {
		this.showList("The process is gone.");
		return this.renderList(width);
	}

	private showList(message?: string): void {
		this.mode = "list";
		this.processKey = undefined;
		this.message = message;
		this.tui.requestRender();
	}

	private showError(message: string): void {
		this.message = message;
		this.tui.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		this.unsubscribe();
	}
}

export async function openProcessHub(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	sources: readonly ProcessHubSource[],
	initialProcessKey?: string,
): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	const model = new ProcessHubCollection(sources);
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new FullscreenOverlay(tui, theme, new ProcessHub(model, tui, theme, done, initialProcessKey), {
				label: "Process Hub",
				icon: "tools",
			}),
		{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
	);
}

function processLabel(snapshot: ProcessHubSnapshot): string {
	return `${snapshot.owner} process #${snapshot.id}`;
}

function outputLines(output: string, width: number): string[] {
	if (output.length === 0) return [];
	return output
		.replace(/\n$/, "")
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line.replaceAll("\t", "    "), Math.max(1, width)));
}

function sanitizeLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}
